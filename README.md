# Vision Profesor de Arte

App de webcam que funciona como un profesor de arte con ojos. Le apuntás al bastidor y te guía mientras pintás.

**Stack:** FastAPI + Gemini Flash (gratis) + OpenCV

## Quick Start

```bash
# 1. Clonar
git clone https://github.com/pmachadojulio/vision-profesor-de-arte.git
cd vision-profesor-de-arte

# 2. Instalar dependencias
pip install -r requirements.txt

# 3. Configurar API Key (gratis)
cp .env.example .env
# editá .env y pegá tu GEMINI_API_KEY
# (https://aistudio.google.com/app/apikey → Create API key)

# 4. Ejecutar
python3 -m uvicorn app:app --host 0.0.0.0 --port 8000
# abrí http://localhost:8000
```

O directamente: `bash start.sh`

## Uso

1. **Activar cámara** → encuadrá SOLO el lienzo (que ocupe ~70% del cuadro, luz pareja)
2. Elegí estilo: `Andrew Cadima` / `Rembrandt` / `Sorolla` / `Zorn` / `Libre`
3. **Analizar lienzo** o activá **Auto cada Ns** para modo videollamada
4. Hablá con el chat: "¿cómo apago ese verde?" / "¿dónde pongo el foco?"

- **Barra espaciadora** = analizar
- **Botón 🔊** = voz (lee el feedback)

## Estilos incluidos

| Estilo | Descripción |
|--------|-------------|
| Andrew Cadima | Luz atmosférica, paleta tierra apagada, pincelada suelta |
| Rembrandt | Claroscuro, triángulo de luz, empaste selectivo |
| Sorolla | Luz natural, paleta cálida, pincelada directa |
| Zorn | Paleta limitada (4 colores), valores precisos |
| Libre | Sin restricciones de estilo |

## Features

- **Crítica en tiempo real** con formato profesional: DIAGNÓSTICO → PRIORIDAD → UBICACIÓN → MEZCLA → VALOR (1–5) → APLICACIÓN → NO TOCAR → DESPUÉS
- **Overlay de correcciones** con bordes duros/blandos/perdidos
- **Detección automática de bordes** (OpenCV)
- **Métricas de valor** (brillo, contraste, saturación)
- **Comparación temporal** ANTES→DESPUÉS
- **Voz TTS** con acento rioplatense
- **Historial persistente** en IndexedDB
- **Modo profesor exigente** (sesiones ≥ 3)
- **59 tests** (42 backend + 17 E2E con Playwright)

## API Key

Gratis en [Google AI Studio](https://aistudio.google.com/app/apikey):
- Gemini Flash = 60 req/min, 1500 req/día, sin tarjeta

## License

MIT
