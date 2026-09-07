#!/bin/bash
cd "$(dirname "$0")"
echo "🎨 Vision Profesor de Arte — http://localhost:8000"
echo "Tip: pega tu GEMINI_API_KEY en la web o en .env"
python3 -m uvicorn app:app --host 0.0.0.0 --port 8000 --app-dir .
