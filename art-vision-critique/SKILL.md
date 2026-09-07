---
name: art-vision-critique
description: Profesor de arte con visión local (Llama 3.2 Vision / Qwen-VL / Moondream) para criticar lienzos en tiempo real. Usa grilla áurea, análisis B/N y prompt de taller rioplatense. Para cuando el usuario pinta y quiere feedback tipo "valor flojo, avanza más claro arriba del campo".
---

# art-vision-critique — Profesor de arte con Llama Vision

Skill para el proyecto **App Vision y profesor de arte** — convierte cualquier VLM local (Ollama) en un profesor que ve tu bastidor 30x40 por cámara.

## Cuando usar

- Usuario dice "analiza mi lienzo", "guía estilo Cadima/Rembrandt", "luz mala", "dónde aclarar"
- Quiere feedback hiper-específico pero directo: `el valor está flojo, avanza más claro arriba...`
- Está en el taller con la compu a 50cm y fondo con ruido (pared/impresora) — necesita selección manual del lienzo
- Tocó cuota Gemini (20/día en gemini-3-flash) y quiere fallback local sin nube

## Stack del proyecto

- Frontend: `static/index.html` — video + `gridCanvas` (grilla áurea Φ 0.618 / tercios / espiral) + `bwPreview` + `hist` (B/N 5 zonas) + `cornerHandles` para selección manual
- Backend: `app.py` — FastAPI + `google-genai` (Gemini 3 Flash Preview) con fallback a Ollama `moondream` / `qwen2.5vl:3b` / `llama3.2-vision`
- `.env`: `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3-flash-preview`, `OLLAMA_MODEL=moondream`
- Ollama bin en `~/bin/ollama`, serve en `127.0.0.1:11434`

## Prompt de taller (no tocar sin testear)

```
Eres mi profesor de arte personal, de taller. Ves mi lienzo por cámara. Hablas como un pintor al lado del caballete.
Estilo: "el valor tonal esta flojo, avanza mas claro arriba del campo y mas oscuro en la calle..."
REGLAS: 2 correcciones max, 2-3 frases completas, nombra zona simple, prioriza VALOR TONAL con métricas B/N, si referencia no tiene nada que ver ignorala, termina con orden de 30s. NUNCA dejes frase a mitad.
```

Ver `app.py:66 SYSTEM_BASE` para la versión completa hiper-específica.

## Cómo correr Llama Vision local

```bash
export PATH="$HOME/bin:$PATH"
# instalar binario sin sudo (ya está en ~/bin/ollama)
~/bin/ollama serve &  # 127.0.0.1:11434
~/bin/ollama pull llama3.2-vision        # 11B ~7.8GB, recomendado M4 16GB
~/bin/ollama pull qwen2.5vl:3b           # 3B fallback rápido
~/bin/ollama pull moondream              # 1.7B ultra-ligero

# test directo sin app:
ollama run llama3.2-vision "Analiza este lienzo al estilo Cadima, dime donde aclarar y mezcla" --image cuadro.jpg
# o via API:
curl http://127.0.0.1:11434/api/generate -d '{"model":"llama3.2-vision","prompt":"Describe","images":["<base64>"]}'
```

Para M4 16GB: `llama3.2-vision:11b` es top (8GB), `qwen3-vl:8b` y `minicpm-v:8b` son alternativas 6GB.

## Flujo híbrido lienzo 30x40

1. Auto-detección OpenCV.js busca rectángulo 3:4 (0.58-0.92 ratio, >8% área) cada 700ms
2. Si a 50cm hay ruido, usa **◫ Seleccionar lienzo** → arrastra 4 esquinas → `manualQuad` → grilla e histograma se anclan al lienzo, y `captureBase64()` recorta al bbox para mandar solo el cuadro a la IA
3. Grilla: tercios / áurea Φ / áurea+diagonales / espiral Fibonacci (selector esquina) / diagonales barrocas — dibujada en `gridCanvas` interpolando dentro del quad si hay detección

## Uso en la app

- `http://localhost:8000` o `http://192.168.0.12:8000` en el celu (misma WiFi, `./start.sh`)
- Intervalo por defecto **Manual** — apretá **Espacio** para analizar, no Auto cada 5s (quema cuota 20/día)
- Referencia opcional: subí foto, tildá `Comparar`; si es un perro y pintás paisaje, el prompt la ignora
- Voz: trocea en 800c para no cortar a mitad

## Troubleshooting

- `ascii codec can't encode \xe1` → parcheado en `app.py:15` con `httpx._models._normalize_header_value` a utf-8
- `503 high demand` / `429 quota 20/día` → espera 30s o cambia a Manual; fallback local ahora devuelve mensaje claro en vez de ` és/és...` loopeado
- `Failed to load image` en Ollama → era base64 truncado de test 1x1; con imagen real de cámara (320x240+) funciona
- Pull atascado a 57% → `pkill ollama; ollama serve` y re-pull

## Próximos pasos

- Pulir fallback local con prompt corto (ya está acortado a 2 frases para no exceder 2048 ctx de moondream)
- Si querés, fine-tune con tus cuadros + correcciones para que aprenda tu paleta
