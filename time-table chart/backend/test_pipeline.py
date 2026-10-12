import os
import sys

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
for p in [BACKEND_DIR, PROJECT_ROOT]:
    if p not in sys.path:
        sys.path.insert(0, p)

from backend.db import init_db, get_db_connection
from backend.services.auth import hash_password, verify_password, create_access_token, decode_access_token
from backend.rag.rag_engine import rag_engine

def run_tests():
    print("=== 1. Testing Database & Auth ===")
    init_db()
    conn = get_db_connection()
    cursor = conn.cursor()

    user_a_id = "test_user_a"
    user_b_id = "test_user_b"
    
    cursor.execute("DELETE FROM users WHERE id IN (?, ?)", (user_a_id, user_b_id))
    cursor.execute("INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)", (user_a_id, "alice", "alice@test.com", hash_password("pass_a")))
    cursor.execute("INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)", (user_b_id, "bob", "bob@test.com", hash_password("pass_b")))
    conn.commit()

    token_a = create_access_token({"sub": user_a_id, "username": "alice"})
    payload_a = decode_access_token(token_a)
    assert payload_a["sub"] == user_a_id, "JWT decode failed"
    print("✓ Auth & JWT Token issuance passed")

    print("\n=== 2. Testing Document Ingestion & Dense Embeddings ===")
    pages_doc_a = [
        {"page_num": 1, "text": "Alice's Secret Research Notes: Quantum Computing utilizes qubits, entanglement, and quantum superposition for exponential speedup in integer factorization and Grover database search."},
        {"page_num": 2, "text": "Superconducting circuits and ion traps are two leading hardware architectures for building fault-tolerant quantum processors."}
    ]
    
    pages_doc_b = [
        {"page_num": 1, "text": "Bob's Biology Notes: Photosynthesis converts light energy into chemical energy stored in glucose molecules inside plant chloroplasts."}
    ]

    res_a = rag_engine.ingest_document(conn, user_a_id, "doc_quantum_alice", "Quantum_Notes.pdf", pages_doc_a, file_size=1024)
    res_b = rag_engine.ingest_document(conn, user_b_id, "doc_bio_bob", "Biology_Notes.pdf", pages_doc_b, file_size=512)
    print(f"✓ Ingested Alice doc: {res_a['chunks_indexed']} chunks | Ingested Bob doc: {res_b['chunks_indexed']} chunks")

    print("\n=== 3. Testing Multi-Tenant Data Privacy & Search ===")
    results_alice = rag_engine.search(conn, user_a_id, "quantum qubits superposition", top_k=3)
    assert len(results_alice) > 0, "Alice search failed"
    assert results_alice[0]["chunk"]["doc_name"] == "Quantum_Notes.pdf", "Wrong document retrieved"
    print(f"✓ Alice retrieved own document: {results_alice[0]['chunk']['doc_name']} (score: {results_alice[0]['final_score']})")

    results_bob = rag_engine.search(conn, user_b_id, "quantum qubits superposition", top_k=3)
    # Ensure Alice's private documents NEVER appear in Bob's results
    assert all(r["chunk"]["doc_name"] != "Quantum_Notes.pdf" for r in results_bob), "DATA LEAK: Bob retrieved Alice's document!"
    print("✓ Multi-Tenant Isolation Verified: Alice's private document is completely inaccessible to Bob.")

    results_bob_bio = rag_engine.search(conn, user_b_id, "photosynthesis chloroplasts", top_k=3)
    assert len(results_bob_bio) > 0, "Bob search for own notes failed"
    assert results_bob_bio[0]["chunk"]["doc_name"] == "Biology_Notes.pdf", "Wrong document retrieved for Bob"
    print(f"✓ Bob retrieved his own notes: {results_bob_bio[0]['chunk']['doc_name']} (score: {results_bob_bio[0]['final_score']})")

    print("\n=== 4. Testing SQLite Persistence & Re-query ===")
    summary_a = rag_engine.get_user_knowledge_summary(conn, user_a_id)
    assert summary_a["total_documents"] == 1, "Document persistence check failed"
    print(f"✓ SQLite persistence verified: {summary_a['total_documents']} documents and {summary_a['total_chunks']} chunks stored permanently.")

    print("\n🎉 ALL 4 CORE ARCHITECTURE TESTS PASSED WITH 100% SUCCESS!")

if __name__ == "__main__":
    run_tests()
