import urllib.request
import json
import os
import re
import traceback

GEMINI_MODEL_PRIMARY = "gemini-2.5-flash-lite"
GEMINI_MODEL_FALLBACK = "gemini-2.5-flash"

def clean_html(raw_html: str) -> str:
    text = re.sub(r'<[^<]+?>', '', raw_html)
    text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&#x27;', "'").replace('&#39;', "'").replace('&nbsp;', ' ')
    return text.strip()

def ddg_search(query: str):
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            html = response.read().decode('utf-8', errors='ignore')
            results = []
            matches = re.findall(r'<div class="result__body">(.*?)</div>\s*</div>', html, re.DOTALL)
            for m in matches:
                url_m = re.search(r'href="([^"]+)"', m)
                title_m = re.search(r'<a class="result__url"[^>]*>(.*?)</a>', m, re.DOTALL)
                snippet_m = re.search(r'<a class="result__snippet"[^>]*>(.*?)</a>', m, re.DOTALL)
                if not snippet_m:
                    snippet_m = re.search(r'<div class="result__snippet"[^>]*>(.*?)</div>', m, re.DOTALL)
                if url_m and (title_m or snippet_m):
                    u = url_m.group(1)
                    if 'uddg=' in u:
                        parsed_u = urllib.parse.urlparse(u)
                        queries = urllib.parse.parse_qs(parsed_u.query)
                        if 'uddg' in queries:
                            u = queries['uddg'][0]
                    t = clean_html(title_m.group(1)) if title_m else "Result"
                    s = clean_html(snippet_m.group(1)) if snippet_m else ""
                    if t and len(t) > 3:
                        results.append({"title": t, "snippet": s, "url": u})
            return results[:6]
    except Exception as e:
        print("[AI SERVC] DDG Search error:", e)
        return []

def _gemini_request(model, prompt, api_key, expect_json):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    data = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 4096
        }
    }
    if expect_json:
        data["generationConfig"]["responseMimeType"] = "application/json"

    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode('utf-8'),
        headers={'Content-Type': 'application/json'}
    )
    with urllib.request.urlopen(req, timeout=45) as response:
        res_data = json.loads(response.read().decode('utf-8'))
        candidates = res_data.get('candidates', [])
        if not candidates:
            reason = res_data.get('promptFeedback', {}).get('blockReason', 'unknown')
            raise ValueError(f"No candidates returned (blockReason={reason})")
        return candidates[0]['content']['parts'][0]['text']

def call_gemini(prompt: str, api_key: str, expect_json: bool = False):
    if not api_key or not api_key.strip():
        return None, "No Gemini API key provided."
    api_key = api_key.strip()
    last_error = None
    for model in (GEMINI_MODEL_PRIMARY, GEMINI_MODEL_FALLBACK):
        try:
            text = _gemini_request(model, prompt, api_key, expect_json)
            return text, None
        except Exception as e:
            last_error = f"{type(e).__name__} from {model}: {e}"
    return None, last_error

def call_groq(prompt: str, api_key: str, history=None, expect_json: bool = False):
    if not api_key or not api_key.strip():
        return None, "No Groq API key provided."
    api_key = api_key.strip()
    url = "https://api.groq.com/openai/v1/chat/completions"

    messages = [{"role": "system", "content": "You are EasyLearn RAG Assistant -- an expert learning mentor and retrieval coach."}]
    if history:
        for msg in history:
            messages.append({"role": "user" if msg.get("role") == "user" else "assistant", "content": msg.get("text", "")})
    messages.append({"role": "user", "content": prompt})

    data = {
        "model": "llama-3.3-70b-versatile",
        "messages": messages,
        "temperature": 0.2
    }
    if expect_json:
        data["response_format"] = {"type": "json_object"}

    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {api_key}'}
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            return res_data['choices'][0]['message']['content'], None
    except Exception as e:
        return None, f"Groq Error: {str(e)}"
