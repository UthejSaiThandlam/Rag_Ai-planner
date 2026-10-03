import re
import math
from typing import List, Dict, Any, Tuple

class TextChunker:
    """Document processing and semantic chunking service."""
    
    def __init__(self, chunk_size: int = 500, overlap: int = 100):
        self.chunk_size = chunk_size
        self.overlap = overlap

    def chunk_document(self, doc_id: str, doc_name: str, pages_text: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Splits extracted document pages into overlapping chunks with page and metadata tracking.
        pages_text: [{'page_num': 1, 'text': '...'}]
        """
        chunks = []
        global_chunk_idx = 0

        for page in pages_text:
            page_num = page.get('page_num', 1)
            text = page.get('text', '').strip()
            if not text:
                continue

            # Split text by paragraphs/sentences roughly
            paragraphs = re.split(r'\n\s*\n', text)
            current_chunk = ""
            
            for para in paragraphs:
                para = para.strip()
                if not para:
                    continue
                    
                if len(current_chunk) + len(para) + 1 <= self.chunk_size:
                    current_chunk += ("\n" + para if current_chunk else para)
                else:
                    if current_chunk:
                        global_chunk_idx += 1
                        chunks.append({
                            "chunk_id": f"{doc_id}_c{global_chunk_idx}",
                            "doc_id": doc_id,
                            "doc_name": doc_name,
                            "page_num": page_num,
                            "chunk_index": global_chunk_idx,
                            "content": current_chunk,
                            "char_count": len(current_chunk)
                        })
                        # Keep overlap from current_chunk end
                        current_chunk = current_chunk[-self.overlap:] + "\n" + para
                    else:
                        # Paragraph itself exceeds chunk size, split by length
                        for i in range(0, len(para), self.chunk_size - self.overlap):
                            sub_text = para[i:i + self.chunk_size]
                            global_chunk_idx += 1
                            chunks.append({
                                "chunk_id": f"{doc_id}_c{global_chunk_idx}",
                                "doc_id": doc_id,
                                "doc_name": doc_name,
                                "page_num": page_num,
                                "chunk_index": global_chunk_idx,
                                "content": sub_text,
                                "char_count": len(sub_text)
                            })
                        current_chunk = ""

            if current_chunk:
                global_chunk_idx += 1
                chunks.append({
                    "chunk_id": f"{doc_id}_c{global_chunk_idx}",
                    "doc_id": doc_id,
                    "doc_name": doc_name,
                    "page_num": page_num,
                    "chunk_index": global_chunk_idx,
                    "content": current_chunk,
                    "char_count": len(current_chunk)
                })

        return chunks


class VectorRAGEngine:
    """
    In-Memory Vector Search & Hybrid BM25 Retrieval Engine.
    Computes vector TF-IDF + Cosine Similarity embeddings combined with Keyword BM25 scoring.
    """
    
    def __init__(self):
        self.documents: Dict[str, Dict[str, Any]] = {}  # doc_id -> doc info
        self.chunks: List[Dict[str, Any]] = []           # All indexed chunks
        self.vocabulary: Dict[str, int] = {}             # word -> feature index
        self.idf: Dict[str, float] = {}                  # word -> idf weight
        self.chunk_vectors: List[Dict[int, float]] = []  # sparse vectors

    def _tokenize(self, text: str) -> List[str]:
        """Simple tokenizer removing punctuation and converting to lowercase."""
        return re.findall(r'\b[a-zA-Z0-9_-]{2,}\b', text.lower())

    def index_document(self, doc_id: str, doc_name: str, pages_text: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Processes document into chunks and rebuilds vector index."""
        chunker = TextChunker()
        new_chunks = chunker.chunk_document(doc_id, doc_name, pages_text)

        # Remove existing chunks for doc_id if re-indexing
        self.chunks = [c for c in self.chunks if c['doc_id'] != doc_id]
        self.chunks.extend(new_chunks)

        self.documents[doc_id] = {
            "doc_id": doc_id,
            "doc_name": doc_name,
            "chunk_count": len(new_chunks),
            "status": "Indexed"
        }

        # Rebuild vector space model
        self._rebuild_vector_index()

        return {
            "doc_id": doc_id,
            "doc_name": doc_name,
            "chunks_count": len(new_chunks),
            "total_chunks": len(self.chunks)
        }

    def delete_document(self, doc_id: str):
        """Removes a document from index."""
        if doc_id in self.documents:
            del self.documents[doc_id]
        self.chunks = [c for c in self.chunks if c['doc_id'] != doc_id]
        self._rebuild_vector_index()

    def _rebuild_vector_index(self):
        """Recomputes TF-IDF vector representations across all stored chunks."""
        self.vocabulary = {}
        self.idf = {}
        self.chunk_vectors = []

        if not self.chunks:
            return

        N = len(self.chunks)
        df: Dict[str, int] = {}
        chunk_token_counts: List[Dict[str, int]] = []

        for chunk in self.chunks:
            tokens = self._tokenize(chunk['content'])
            counts: Dict[str, int] = {}
            for t in tokens:
                counts[t] = counts.get(t, 0) + 1
            chunk_token_counts.append(counts)

            for t in set(tokens):
                df[t] = df.get(t, 0) + 1

        # Build Vocabulary and IDF
        vocab_idx = 0
        for term, doc_freq in df.items():
            self.vocabulary[term] = vocab_idx
            # Inverse Document Frequency (smooth IDF)
            self.idf[term] = math.log((N + 1) / (doc_freq + 1)) + 1.0
            vocab_idx += 1

        # Compute TF-IDF sparse vectors
        for counts in chunk_token_counts:
            vec = {}
            total_words = sum(counts.values()) or 1
            for term, count in counts.items():
                if term in self.vocabulary:
                    tf = count / total_words
                    term_idx = self.vocabulary[term]
                    vec[term_idx] = tf * self.idf[term]
            self.chunk_vectors.append(vec)

    def _vector_similarity(self, query_vec: Dict[int, float], chunk_vec: Dict[int, float]) -> float:
        """Computes Cosine Similarity between query vector and chunk vector."""
        dot_product = 0.0
        query_norm = 0.0
        chunk_norm = 0.0

        for idx, val in query_vec.items():
            query_norm += val * val
            if idx in chunk_vec:
                dot_product += val * chunk_vec[idx]

        for val in chunk_vec.values():
            chunk_norm += val * val

        if query_norm == 0.0 or chunk_norm == 0.0:
            return 0.0

        return dot_product / (math.sqrt(query_norm) * math.sqrt(chunk_norm))

    def search(self, query: str, top_k: int = 5, mode: str = "hybrid", doc_filter: str = None) -> List[Dict[str, Any]]:
        """
        Executes semantic, keyword, or hybrid search over indexed document chunks.
        Modes: 'semantic', 'keyword', 'hybrid'
        """
        if not self.chunks or not query.strip():
            return []

        tokens = self._tokenize(query)
        if not tokens:
            return []

        # Build Query Vector
        query_vec = {}
        counts: Dict[str, int] = {}
        for t in tokens:
            counts[t] = counts.get(t, 0) + 1

        total_q_words = len(tokens)
        for term, count in counts.items():
            if term in self.vocabulary:
                term_idx = self.vocabulary[term]
                tf = count / total_q_words
                query_vec[term_idx] = tf * self.idf[term]

        results = []
        for idx, chunk in enumerate(self.chunks):
            if doc_filter and chunk['doc_id'] != doc_filter and chunk['doc_name'] != doc_filter:
                continue

            chunk_vec = self.chunk_vectors[idx]
            
            # Vector / Semantic score
            sim_score = self._vector_similarity(query_vec, chunk_vec)

            # Keyword match score (BM25 simplified ratio)
            content_lower = chunk['content'].lower()
            kw_matches = sum(1 for t in tokens if t in content_lower)
            kw_score = kw_matches / len(tokens)

            # Combine based on search mode
            if mode == "semantic":
                final_score = sim_score
            elif mode == "keyword":
                final_score = kw_score
            else:  # Hybrid
                final_score = (0.7 * sim_score) + (0.3 * kw_score)

            if final_score > 0.01:
                results.append({
                    "chunk": chunk,
                    "similarity_score": round(sim_score, 4),
                    "keyword_score": round(kw_score, 4),
                    "final_score": round(final_score, 4)
                })

        # Sort by final score descending
        results.sort(key=lambda x: x['final_score'], reverse=True)
        return results[:top_k]

    def get_knowledge_summary(self) -> Dict[str, Any]:
        """Returns metadata about the active Knowledge Base."""
        return {
            "total_documents": len(self.documents),
            "total_chunks": len(self.chunks),
            "documents": list(self.documents.values())
        }

