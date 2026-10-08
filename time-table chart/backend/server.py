import http.server
import socketserver
import json
import os
import sys
import traceback
import base64
import io
import time

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
FRONTEND_DIR = os.path.join(PROJECT_ROOT, 'frontend')

# Add paths to sys.path so modules resolve cleanly
for p in [BACKEND_DIR, PROJECT_ROOT]:
    if p not in sys.path:
        sys.path.insert(0, p)

try:
    from backend.rag.rag_engine import VectorRAGEngine
    from backend.services.ai_service import call_gemini, call_groq, ddg_search
except ImportError:
    from rag.rag_engine import VectorRAGEngine
    from services.ai_service import call_gemini, call_groq, ddg_search

try:
    import pypdf
except ImportError:
    pypdf = None

try:
    import docx
except ImportError:
    docx = None

# Global RAG Engine Instance
rag_engine = VectorRAGEngine()

def load_env():
    for base in [PROJECT_ROOT, BACKEND_DIR]:
        env_path = os.path.join(base, '.env')
        if os.path.exists(env_path):
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, v = line.split('=', 1)
                        val = v.strip().strip("'").strip('"')
                        os.environ[k.strip()] = val
            print(f"[ENV] Loaded .env successfully from {env_path}. GROQ_API_KEY set: {bool(os.environ.get('GROQ_API_KEY'))}, GEMINI_API_KEY set: {bool(os.environ.get('GEMINI_API_KEY'))}")
            return
    print("[ENV] No .env file found.")

load_env()


class RAGServerHandler(http.server.SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FRONTEND_DIR, **kwargs)

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-AI-Provider, X-Groq-API-Key')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-AI-Provider, X-Groq-API-Key')
        self.end_headers()

    def do_GET(self):
        if self.path == '/healthz':
            return self.send_json({"status": "healthy"})
        if self.path == '/api/knowledge-base':
            return self.send_json(rag_engine.get_knowledge_summary())
        # Handle /frontend/ prefixes gracefully if any client sends it
        if self.path.startswith('/frontend/'):
            self.path = self.path[len('/frontend'):]
        return super().do_GET()

    def do_POST(self):
        if self.path == '/api/upload-document':
            return self.handle_upload_document()
        elif self.path == '/api/rag/search':
            return self.handle_rag_search()
        elif self.path == '/api/rag/chat' or self.path == '/api/chat':
            return self.handle_rag_chat()
        elif self.path == '/api/generate-plan':
            return self.handle_generate_plan()
        else:
            self.send_json({"error": "Endpoint not found"}, 404)

    def read_json_body(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            return {}
        body = self.rfile.read(content_length).decode('utf-8')
        return json.loads(body)

    def get_api_key(self, body):
        header_key = (self.headers.get('X-API-Key') or '').strip()
        body_key = (body.get('apiKey') or '').strip()
        env_key = (os.environ.get('GEMINI_API_KEY') or '').strip()
        return header_key or body_key or env_key

    def get_groq_api_key(self, body):
        header_key = (self.headers.get('X-Groq-API-Key') or '').strip()
        body_key = (body.get('groqApiKey') or '').strip()
        env_key = (os.environ.get('GROQ_API_KEY') or '').strip()
        return header_key or body_key or env_key


    def handle_upload_document(self):
        try:
            body = self.read_json_body()
            filename = body.get('filename', '').strip()
            base64_data = body.get('base64', '').strip()

            if not filename or not base64_data:
                return self.send_json({"error": "Filename and base64 content required"}, 400)

            file_bytes = base64.b64decode(base64_data)
            ext = os.path.splitext(filename.lower())[1]
            pages_text = []

            if ext == '.pdf':
                if not pypdf:
                    return self.send_json({"error": "pypdf library missing on server"}, 500)
                pdf_reader = pypdf.PdfReader(io.BytesIO(file_bytes))
                for i, page in enumerate(pdf_reader.pages):
                    pages_text.append({"page_num": i + 1, "text": page.extract_text() or ""})
            elif ext in ('.docx', '.doc'):
                if not docx:
                    return self.send_json({"error": "python-docx library missing"}, 500)
                doc = docx.Document(io.BytesIO(file_bytes))
                text = "\n".join([p.text for p in doc.paragraphs])
                pages_text.append({"page_num": 1, "text": text})
            else:
                text = file_bytes.decode('utf-8', errors='replace')
                pages_text.append({"page_num": 1, "text": text})

            doc_id = f"doc_{int(time.time())}"
            index_res = rag_engine.index_document(doc_id, filename, pages_text)

            self.send_json({
                "success": True,
                "doc_id": doc_id,
                "filename": filename,
                "chunks_indexed": index_res['chunks_count'],
                "total_kb_chunks": index_res['total_chunks']
            })

        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": str(e)}, 500)

    def handle_rag_search(self):
        try:
            body = self.read_json_body()
            query = body.get('query', '').strip()
            mode = body.get('mode', 'hybrid')  # semantic, keyword, hybrid
            top_k = int(body.get('top_k', 5))

            if not query:
                return self.send_json({"error": "Query parameter is required"}, 400)

            results = rag_engine.search(query, top_k=top_k, mode=mode)
            self.send_json({
                "query": query,
                "mode": mode,
                "count": len(results),
                "results": results
            })
        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": str(e)}, 500)

    def handle_rag_chat(self):
        try:
            body = self.read_json_body()
            message = body.get('message', '').strip()
            history = body.get('history', [])
            mode = body.get('mode', 'study')  # study, research, quiz, interview

            if not message:
                return self.send_json({"error": "Message is required"}, 400)

            # Determine provider automatically:
            # Gemini for calculations, math, formulas, numbers, statistics, evaluation
            calc_keywords = ["calculate", "math", "equation", "sum", "formula", "eval", "percentage", "count", "average", "stats", "matrix", "derivative", "integral", "solve", "+", "*", "/", "="]
            is_calculation = any(kw in message.lower() for kw in calc_keywords)
            
            # Load API keys directly from environment (.env)
            groq_key = (os.environ.get('GROQ_API_KEY') or '').strip()
            gemini_key = (os.environ.get('GEMINI_API_KEY') or '').strip()

            if is_calculation and gemini_key:
                provider = "gemini"
                api_key = gemini_key
            elif gemini_key:
                provider = "gemini"
                api_key = gemini_key
            elif groq_key:
                provider = "groq"
                api_key = groq_key
            else:
                provider = "gemini"
                api_key = ""

            # Perform RAG Vector Search across Knowledge Base
            start_time = time.time()
            retrieved_chunks = rag_engine.search(message, top_k=5, mode="hybrid")
            retrieval_ms = round((time.time() - start_time) * 1000, 2)

            # Format context with explicit citation metadata
            context_blocks = []
            citations = []
            for r in retrieved_chunks:
                c = r['chunk']
                context_blocks.append(f"--- [SOURCE #{r['final_score']} Sim: {r['similarity_score']}] File: {c['doc_name']} (Page {c['page_num']}, Chunk ID: {c['chunk_id']}) ---\n{c['content']}")
                citations.append({
                    "doc_name": c['doc_name'],
                    "page_num": c['page_num'],
                    "chunk_id": c['chunk_id'],
                    "similarity": r['similarity_score'],
                    "snippet": c['content'][:150] + "..."
                })

            rag_context = "\n\n".join(context_blocks)

            prompt = f"""You are EasyLearn AI — an expert AI Learning Assistant.

RETRIEVED KNOWLEDGE BASE CONTEXT:
{rag_context if rag_context else "(No uploaded documents matching this query)"}

User Question: "{message}"

INSTRUCTIONS:
1. Directly answer the user's question clearly, concisely, and accurately.
2. If RETRIEVED KNOWLEDGE BASE CONTEXT is available and relevant, prioritize it and cite source filenames/page numbers in square brackets like [Document.pdf, Page X].
3. If no relevant documents are in the knowledge base, use your general expert knowledge to fully answer the user's question directly. Do NOT refuse to answer just because a document is missing.
4. Keep the answer structured, well-formatted, and helpful."""

            if not api_key:
                return self.send_json({
                    "message": f"⚠️ API key for {provider.upper()} is missing in .env file.",
                    "retrieved_context": retrieved_chunks,
                    "citations": citations,
                    "retrieval_time_ms": retrieval_ms,
                    "provider": provider
                })

            response_text = None
            error = None

            if provider == 'groq':
                response_text, error = call_groq(prompt, api_key, history)
                # Automatic fallback to Gemini if Groq fails or key is invalid
                if not response_text and gemini_key:
                    print(f"[CHAT FALLBACK] Groq error ({error}), falling back to Gemini.")
                    provider = 'gemini'
                    response_text, error = call_gemini(prompt, gemini_key)
            else:
                response_text, error = call_gemini(prompt, api_key)
                if not response_text and groq_key:
                    print(f"[CHAT FALLBACK] Gemini error ({error}), falling back to Groq.")
                    provider = 'groq'
                    response_text, error = call_groq(prompt, groq_key, history)

            if not response_text:
                return self.send_json({
                    "message": f"❌ AI call failed: {error or 'Unknown error'}",
                    "retrieved_context": retrieved_chunks,
                    "citations": citations,
                    "retrieval_time_ms": retrieval_ms,
                    "provider": provider
                })

            self.send_json({
                "message": response_text,
                "retrieved_context": retrieved_chunks,
                "citations": citations,
                "retrieval_time_ms": retrieval_ms,
                "provider": provider
            })

        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": str(e)}, 500)

    def handle_generate_plan(self):
        """Generate AI-powered learning roadmap with subtopics, modules, and resources."""
        try:
            body = self.read_json_body()
            topic = body.get('topic', '').strip()
            depth = body.get('depth', 'beginner')
            daily_hours = float(body.get('daily_hours', 2))

            if not topic:
                return self.send_json({"error": "Topic is required"}, 400)

            groq_key = (os.environ.get('GROQ_API_KEY') or '').strip()
            gemini_key = (os.environ.get('GEMINI_API_KEY') or '').strip()

            # Prefer Gemini for structured generation (JSON)
            api_key = gemini_key or groq_key
            provider = 'gemini' if gemini_key else ('groq' if groq_key else None)

            plan_prompt = f"""Generate a structured JSON learning roadmap for the topic: "{topic}"
Level: {depth}
Daily study hours: {daily_hours}

Return ONLY a valid JSON object with this EXACT structure:
{{
  "roadmap": {{
    "name": "{topic}",
    "description": "Brief 1-line description of the learning path",
    "children": [
      {{
        "name": "Subtopic Name",
        "description": "What this subtopic covers",
        "estimated_hours": 3,
        "status": "upcoming",
        "resources": ["Resource 1", "Resource 2"]
      }}
    ]
  }},
  "modules": [
    {{
      "name": "Session: specific task name",
      "duration": 45,
      "priority": "high",
      "category": "learning",
      "subtopic_index": 0,
      "completed": false,
      "splittable": true
    }}
  ],
  "summary": {{
    "total_hours": 20,
    "daily_hours": {daily_hours},
    "estimated_days": 10
  }}
}}

Rules:
- Generate 4-8 subtopics (children) with realistic hour estimates
- Generate 2-4 study session modules per subtopic (8-20 total)
- Each module duration should be 30-90 minutes
- Priority can be "high", "medium", or "low"
- Category can be "learning", "skill", or "personal"
- subtopic_index should match the index of the parent subtopic in the children array
- Make it realistic and actionable for a {depth} level learner
- Return ONLY the JSON, no markdown, no explanation"""

            response_text = None
            error = None

            if provider == 'gemini' and gemini_key:
                response_text, error = call_gemini(plan_prompt, gemini_key, expect_json=True)
                if not response_text and groq_key:
                    print(f"[PLAN FALLBACK] Gemini failed ({error}), trying Groq.")
                    response_text, error = call_groq(plan_prompt, groq_key, expect_json=True)
                    provider = 'groq'
            elif provider == 'groq' and groq_key:
                response_text, error = call_groq(plan_prompt, groq_key, expect_json=True)
                if not response_text and gemini_key:
                    print(f"[PLAN FALLBACK] Groq failed ({error}), trying Gemini.")
                    response_text, error = call_gemini(plan_prompt, gemini_key, expect_json=True)
                    provider = 'gemini'

            if response_text:
                try:
                    # Clean up any markdown fencing
                    cleaned = response_text.strip()
                    if cleaned.startswith('```'):
                        cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
                    if cleaned.endswith('```'):
                        cleaned = cleaned[:-3]
                    cleaned = cleaned.strip()

                    plan_data = json.loads(cleaned)
                    plan_data['is_fallback'] = False
                    print(f"[PLAN] AI generated roadmap for '{topic}' via {provider}: {len(plan_data.get('modules', []))} modules")
                    return self.send_json(plan_data)
                except json.JSONDecodeError as je:
                    print(f"[PLAN] JSON parse failed: {je}. Falling back to structured curriculum.")
                    error = f"AI returned invalid JSON: {je}"

            # Fallback: generate a structured curriculum without AI
            print(f"[PLAN FALLBACK] Generating structured curriculum for '{topic}' (AI unavailable: {error})")
            fallback = self._generate_fallback_plan(topic, depth, daily_hours)
            return self.send_json(fallback)

        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": str(e)}, 500)

    def _generate_fallback_plan(self, topic, depth, daily_hours):
        """Generate a reasonable structured curriculum without AI."""
        subtopics = [
            {"name": f"Introduction to {topic}", "description": f"Overview and fundamentals of {topic}", "estimated_hours": 3, "status": "upcoming", "resources": [f"Search: '{topic} introduction'"]},
            {"name": f"Core Concepts of {topic}", "description": f"Essential building blocks and theory", "estimated_hours": 5, "status": "upcoming", "resources": [f"Search: '{topic} core concepts'"]},
            {"name": f"Practical {topic}", "description": f"Hands-on exercises and projects", "estimated_hours": 6, "status": "upcoming", "resources": [f"Search: '{topic} practical exercises'"]},
            {"name": f"Advanced {topic}", "description": f"Deep dives and specialization", "estimated_hours": 4, "status": "upcoming", "resources": [f"Search: '{topic} advanced topics'"]},
            {"name": f"{topic} Project & Review", "description": f"Capstone project and review", "estimated_hours": 4, "status": "upcoming", "resources": [f"Search: '{topic} projects'"]},
        ]

        modules = []
        for si, sub in enumerate(subtopics):
            sessions = max(2, int(sub['estimated_hours'] / 0.75))
            for s in range(min(sessions, 3)):
                modules.append({
                    "name": f"Study: {sub['name']} - Session {s+1}",
                    "duration": 45,
                    "priority": "high" if si < 2 else "medium",
                    "category": "learning" if si < 3 else "skill",
                    "subtopic_index": si,
                    "completed": False,
                    "splittable": True
                })

        total_hours = sum(s['estimated_hours'] for s in subtopics)
        return {
            "roadmap": {"name": topic, "description": f"Structured learning path for {topic} ({depth} level)", "children": subtopics},
            "modules": modules,
            "summary": {"total_hours": total_hours, "daily_hours": daily_hours, "estimated_days": max(1, int(total_hours / daily_hours))},
            "is_fallback": True,
            "message": "AI was unavailable. Generated a structured curriculum template. You can regenerate once API keys are configured."
        }


PORT = int(os.environ.get("PORT", 8000))

if __name__ == '__main__':
    load_env()
    socketserver.TCPServer.allow_reuse_address = True
    print(f"[START] EasyLearn RAG Server starting on http://localhost:{PORT}")
    print(f"[INFO] Serving frontend from: {FRONTEND_DIR}")
    with socketserver.TCPServer(("", PORT), RAGServerHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[STOP] Server shutting down.")
