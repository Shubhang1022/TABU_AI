# TABU-AI Proxy + Dev Server

This repository contains a small Express proxy server to keep your Groq/OpenRouter API key on the server and a static file server to host the `index.html` frontend locally.

Setup

1. Copy `.env.example` to `.env` and add your API key:

   - Windows PowerShell:

     copy .env.example .env

   Edit `.env` and set `GROQ_API_KEY`.

2. Install dependencies:

   - Windows PowerShell:

     npm install

3. Start the server:

   npm start

4. Open your browser at `http://localhost:3000`.

Notes

- The server exposes `POST /api/generate` which forwards your prompt to the configured `GROQ_API_URL` using the `GROQ_API_KEY` from `.env`.
- The server also serves static files from the project root so your `index.html` will be available at the root.
- Web Speech API requires a secure context: `https://` or `http://localhost`.
