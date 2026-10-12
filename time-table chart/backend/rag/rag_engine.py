import re
import math
import json
import hashlib
import sqlite3
from typing import List, Dict, Any, Tuple, Optional

EMBED_DIM = 256

class StructureAwareChunker:
    """
    Splits documents into semantic, structure-aware passages.
    Preserves paragraph coherence, heading hierarchy, and page numbers.
    Target chunk size: ~350-500 words / ~1200-1600 characters.
    Overlap: ~50-80 words / ~200 characters.
    """
    def __init__(self, target_chars: int = 1200, overlap_chars: int = 200):
        self.target_chars = target_chars
        self.overlap_chars = overlap_chars

    def chunk_document(self, doc_id: str, doc_name: str, pages_text: List[Dict[str, Any]], user_id: str) -> List[Dict[str, Any]]:
        chunks = []
        global_idx = 0

        for p_idx, page in enumerate(pages_text):
            page_num = page.get('page_num', p_idx + 1)
            raw_text = page.get('text', '').strip()
            if not raw_text:
                continue

            paragraphs = re.split(r'\n{2,}|\r\n{2,}', raw_text)
            current_buffer = ""

            for p in paragraphs:
                clean_p = p.strip()
                if not clean_p:
                    continue

                if len(current_buffer) + len(clean_p) + 1 <= self.target_chars:
                    current_buffer += ("\n\n" + clean_p if current_buffer else clean_p)
                else:
                    if current_buffer:
                        global_idx += 1
                        token_est = len(current_buffer.split())
                        chunks.append({
                            "id": f"{doc_id}_c{global_idx}",
                            "doc_id": doc_id,
                            "user_id": user_id,
                            "doc_name": doc_name,
                            "page_num": page_num,
                            "chunk_index": global_idx,
                            "content": current_buffer,
                            "char_count": len(current_buffer),
                            "token_count": token_est
                        })
                        tail = current_buffer[-self.overlap_chars:] if len(current_buffer) > self.overlap_chars else current_buffer
                        current_buffer = tail + "\n\n" + clean_p
                    else:
                        sentences = re.split(r'(?<=[.!?])\s+', clean_p)
                        sub_buf = ""
                        for sent in sentences:
                            if len(sub_buf) + len(sent) + 1 <= self.target_chars:
                                sub_buf += (" " + sent if sub_buf else sent)
                            else:
                                if sub_buf:
                                    global_idx += 1
                                    chunks.append({
                                        "id": f"{doc_id}_c{global_idx}",
                                        "doc_id": doc_id,
                                        "user_id": user_id,
                                        "doc_name": doc_name,
                                        "page_num": page_num,
                                        "chunk_index": global_idx,
                                        "content": sub_buf,
                                        "char_count": len(sub_buf),
                                        "token_count": len(sub_buf.split())
                                    })
                                    sub_buf = sent
                                else:
                                    for i in range(0, len(sent), self.target_chars - self.overlap_chars):
                                        slice_text = sent[i:i + self.target_chars]
                                        global_idx += 1
                                        chunks.append({
                                            "id": f"{doc_id}_c{global_idx}",
                                            "doc_id": doc_id,
                                            "user_id": user_id,
                                            "doc_name": doc_name,
                                            "page_num": page_num,
                                            "chunk_index": global_idx,
                                            "content": slice_text,
                                            "char_count": len(slice_text),
                                            "token_count": len(slice_text.split())
                                        })
                        current_buffer = sub_buf

            if current_buffer.strip():
                global_idx += 1
                chunks.append({
                    "id": f"{doc_id}_c{global_idx}",
                    "doc_id": doc_id,
                    "user_id": user_id,
                    "doc_name": doc_name,
                    "page_num": page_num,
                    "chunk_index": global_idx,
                    "content": current_buffer,
                    "char_count": len(current_buffer),
                    "token_count": len(current_buffer.split())
                })

        return chunks


class DenseVectorEmbeddingEngine:
    def __init__(self, dim: int = EMBED_DIM):
        self.dim = dim

    def _tokenize(self, text: str) -> List[str]:
        return re.findall(r'\b[a-zA-Z0-9_\-]{2,}\b', text.lower())

    def embed_text(self, text: str) -> List[float]:
        vec = [0.0] * self.dim
        tokens = self._tokenize(text)
        if not tokens:
            return vec

        features = list(tokens)
        for i in range(len(tokens) - 1):
            features.append(f"{tokens[i]}_{tokens[i+1]}")

        for term in features:
            h = int(hashlib.md5(term.encode('utf-8')).hexdigest(), 16)
            idx = h % self.dim
            sign = 1.0 if ((h >> 8) % 2 == 0) else -1.0
            weight = math.log(1.0 + len(term))
            vec[idx] += sign * weight

        norm = math.sqrt(sum(v * v for v in vec))
        if norm > 0:
            vec = [round(v / norm, 5) for v in vec]
        return vec

    def cosine_similarity(self, vec_a: List[float], vec_b: List[float]) -> float:
        if not vec_a or not vec_b or len(vec_a) != len(vec_b):
            return 0.0
        dot = sum(a * b for a, b in zip(vec_a, vec_b))
        return max(0.0, min(1.0, dot))


class HybridRAGEngine:
    def __init__(self):
        self.chunker = StructureAwareChunker()
        self.embedder = DenseVectorEmbeddingEngine()
        self._vector_cache: Dict[str, List[float]] = {}
        self._max_cache_size = 8000

    def _cache_vector(self, chunk_id: str, vec: List[float]):
        if len(self._vector_cache) >= self._max_cache_size:
            # Drop oldest 20% to prevent memory bloat
            keys_to_remove = list(self._vector_cache.keys())[:int(self._max_cache_size * 0.2)]
            for k in keys_to_remove:
                self._vector_cache.pop(k, None)
        self._vector_cache[chunk_id] = vec

    def ingest_document(self, conn: sqlite3.Connection, user_id: str, doc_id: str, filename: str, pages_text: List[Dict[str, Any]], file_size: int = 0) -> Dict[str, Any]:
        cursor = conn.cursor()
        
        cursor.execute("""
            INSERT INTO documents (id, user_id, filename, file_size, total_pages, status)
            VALUES (?, ?, ?, ?, ?, 'Processing')
            ON CONFLICT(id) DO UPDATE SET
                filename=excluded.filename,
                file_size=excluded.file_size,
                total_pages=excluded.total_pages,
                status='Processing';
        """, (doc_id, user_id, filename, file_size, len(pages_text)))

        cursor.execute("DELETE FROM chunks WHERE doc_id = ? AND user_id = ?", (doc_id, user_id))

        raw_chunks = self.chunker.chunk_document(doc_id, filename, pages_text, user_id)

        for c in raw_chunks:
            dense_vec = self.embedder.embed_text(c['content'])
            self._cache_vector(c['id'], dense_vec)
            cursor.execute("""
                INSERT INTO chunks (id, doc_id, user_id, chunk_index, page_num, content, char_count, token_count, vector_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (c['id'], doc_id, user_id, c['chunk_index'], c['page_num'], c['content'], c['char_count'], c['token_count'], json.dumps(dense_vec)))

        cursor.execute("UPDATE documents SET total_chunks = ?, status = 'Indexed' WHERE id = ?", (len(raw_chunks), doc_id))
        conn.commit()

        cursor.execute("SELECT COUNT(*) FROM chunks WHERE user_id = ?", (user_id,))
        total_kb_chunks = cursor.fetchone()[0]

        return {
            "doc_id": doc_id,
            "filename": filename,
            "chunks_indexed": len(raw_chunks),
            "total_kb_chunks": total_kb_chunks
        }

    def search(self, conn: sqlite3.Connection, user_id: str, query: str, top_k: int = 5, mode: str = "hybrid", doc_filter: Optional[str] = None) -> List[Dict[str, Any]]:
        clean_q = query.strip()
        if not clean_q:
            return []

        cursor = conn.cursor()
        if doc_filter:
            cursor.execute("""
                SELECT c.id, c.doc_id, d.filename, c.page_num, c.chunk_index, c.content, c.token_count, c.vector_json
                FROM chunks c
                JOIN documents d ON c.doc_id = d.id
                WHERE c.user_id = ? AND (c.doc_id = ? OR d.filename = ?)
            """, (user_id, doc_filter, doc_filter))
        else:
            cursor.execute("""
                SELECT c.id, c.doc_id, d.filename, c.page_num, c.chunk_index, c.content, c.token_count, c.vector_json
                FROM chunks c
                JOIN documents d ON c.doc_id = d.id
                WHERE c.user_id = ?
            """, (user_id,))

        rows = cursor.fetchall()
        if not rows:
            return []

        query_vec = self.embedder.embed_text(clean_q)
        q_tokens = set(re.findall(r'\b[a-zA-Z0-9_\-]{2,}\b', clean_q.lower()))
        num_q_tokens = max(len(q_tokens), 1)

        scored_results = []
        for r in rows:
            chunk_id, doc_id, doc_name, page_num, chunk_index, content, token_count, vector_json = r

            # Fast vector retrieval from in-memory cache to avoid repeated JSON parsing
            chunk_vec = self._vector_cache.get(chunk_id)
            if chunk_vec is None:
                try:
                    chunk_vec = json.loads(vector_json)
                    self._cache_vector(chunk_id, chunk_vec)
                except Exception:
                    chunk_vec = [0.0] * EMBED_DIM

            sim_score = self.embedder.cosine_similarity(query_vec, chunk_vec)

            content_lower = content.lower()
            kw_matches = sum(1 for t in q_tokens if t in content_lower) if q_tokens else 0
            kw_score = kw_matches / num_q_tokens

            if mode == "semantic":
                final_score = sim_score
            elif mode == "keyword":
                final_score = kw_score
            else:  # Hybrid: 70% Semantic, 30% Keyword
                final_score = (0.7 * sim_score) + (0.3 * kw_score)

            if final_score > 0.08:
                scored_results.append({
                    "chunk": {
                        "chunk_id": chunk_id,
                        "doc_id": doc_id,
                        "doc_name": doc_name,
                        "page_num": page_num,
                        "chunk_index": chunk_index,
                        "content": content,
                        "token_count": token_count
                    },
                    "similarity_score": round(sim_score, 4),
                    "keyword_score": round(kw_score, 4),
                    "final_score": round(final_score, 4)
                })

        scored_results.sort(key=lambda x: x['final_score'], reverse=True)
        return scored_results[:top_k]

    def delete_document(self, conn: sqlite3.Connection, user_id: str, doc_id: str) -> bool:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM chunks WHERE doc_id = ? AND user_id = ?", (doc_id, user_id))
        deleted_chunk_ids = [r[0] for r in cursor.fetchall()]
        for cid in deleted_chunk_ids:
            self._vector_cache.pop(cid, None)

        cursor.execute("DELETE FROM documents WHERE id = ? AND user_id = ?", (doc_id, user_id))
        conn.commit()
        return cursor.rowcount > 0

    def get_user_knowledge_summary(self, conn: sqlite3.Connection, user_id: str) -> Dict[str, Any]:
        cursor = conn.cursor()
        cursor.execute("SELECT id, filename, file_size, total_chunks, status, created_at FROM documents WHERE user_id = ?", (user_id,))
        docs = cursor.fetchall()
        cursor.execute("SELECT COUNT(*) FROM chunks WHERE user_id = ?", (user_id,))
        chunks_count = cursor.fetchone()[0]

        return {
            "total_documents": len(docs),
            "total_chunks": chunks_count,
            "documents": [
                {
                    "doc_id": d[0],
                    "doc_name": d[1],
                    "file_size": d[2],
                    "chunk_count": d[3],
                    "status": d[4],
                    "created_at": str(d[5])[:16]
                }
                for d in docs
            ]
        }

rag_engine = HybridRAGEngine()
