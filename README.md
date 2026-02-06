# Gemini Safe Assistant

An AI assistant powered by Gemini 3 that communicates naturally and can perform real-world actions — but only when a signed, policy-bound receipt authorizes execution.

This project demonstrates how advanced AI reasoning can be combined with a cryptographic action gateway to ensure tool use is provable, auditable, replay-safe, and fail-closed. The assistant is transparent about its actions and operates within strict execution boundaries.

## Related project
This assistant uses the open-source AI Action Gateway as its execution boundary:
https://github.com/SCRTHodl/action-gateway

## Quickstart (coming soon)
- Start the gateway: `cd ~/action-gateway && npm run dev`
- Run the assistant demo: `npm install && npm run demo`
