# Paso 0 — Verificación de la CLI en esta máquina

Fecha: 11-nov-2026 · Windows 11 · Node 22.19 · VS Code 1.144 · Claude Code **2.1.322** (instalación npm).

Todas las cifras salen de llamadas reales con `--model haiku --effort low`. Las capturas anonimizadas están en
`test/fixtures/`. Para repetir la verificación en otra máquina: `npm run bench`.

## Lo que coincide con la spec

- Las 13 opciones de §1 existen y se aceptan juntas. `--system-prompt-file` **no aparece en `claude --help`**
  (solo se menciona dentro del texto de `--bare`), pero funciona.
- `--model haiku` → `claude-haiku-5-5`. `tools: []`, `mcp_servers: []`, `apiKeySource: "none"` (suscripción).
- Error (modelo inexistente): `subtype: "success"` con `is_error: true` y el mensaje en `result`, igual que el
  caso de autenticación descrito en la spec. Además el proceso sale con código 1.
- Razonamiento: `thinking_tokens = 0` con `effort low`.

## Diferencias y hallazgos

| # | Hallazgo | Consecuencia en el diseño |
|---|---|---|
| 1 | En esta máquina `claude` es el shim de npm (`claude.cmd`), no el instalador nativo. El shim solo lanza `node_modules\@anthropic-ai\claude-code\bin\claude.exe`. | `resolveCli` resuelve el shim a ese `.exe` y lo lanza con `shell: false`. Si un shim no apunta a un `.exe`, error claro (como pide la spec). |
| 2 | **La CLI no emite nada antes de recibir la primera entrada.** `system/init` llega ~75 ms después de escribir en stdin. | No hay señal de "listo": un proceso en espera se considera caliente por antigüedad. Se puede escribir en stdin en cualquier momento. |
| 3 | Los ajustes de usuario se cuelan en cada petición: los 47 `permissions.additionalDirectories` de `~/.claude/settings.json` añadían **~1.750 tokens por petición** (`--safe-mode` no los desactiva). | Se añade `--setting-sources project`. Como el `cwd` es una carpeta vacía propia, no se carga ningún ajuste. La autenticación sigue funcionando. |
| 4 | **La caché de prompts no sirve en modo de un solo uso**: entre peticiones distintas `cache_read_input_tokens` es siempre 0, pero cada petición *escribe* todo el prompt en la caché de 1 h, que se factura al doble. | `DISABLE_PROMPT_CACHING=1` en modo `single-use` (ajuste `ghostline.promptCache`). Coste equivalente de una petición típica: 0,000405 $ → 0,000213 $ (**−47 %**). |
| 5 | La CLI añade **~600 tokens fijos** por petición aunque el system prompt sea propio y no haya herramientas (medido con system prompt `x` y mensaje `x`: 598 tokens de entrada). | No se puede evitar. El presupuesto del contexto se calcula sobre el total medido, no sobre el mensaje. |
| 6 | El tokenizador de `claude-haiku-5-5` da **~2,4 caracteres por token** en código TypeScript, no 3,5. | El estimador parte de 2,4 y se recalibra solo con el consumo real (`usage/tokenEstimator.ts`). |
| 7 | Tipo de salida nuevo: `rate_limit_event`, con el uso de las ventanas de 5 h y 7 días de la suscripción. No aparecieron `active_goal` ni `autocompact_state`. | El parser ignora lo desconocido; `rate_limit_event` se muestra en el tooltip de la barra de estado. |
| 8 | `result` trae además `ttft_ms`, `time_to_request_ms` y `stop_reason`; `stream_event/message_start` ya trae los tokens de entrada. | Las peticiones canceladas a medias también se contabilizan (los tokens de entrada ya se han gastado). |

## Medidas

| Medida | Valor |
|---|---|
| Arranque en frío: `spawn` → `system/init` (entrada enviada al instante) | ~720 ms |
| Petición con proceso precalentado: entrada → primer token | 620–760 ms |
| Petición con proceso precalentado: entrada → `result` | 830–1.000 ms |
| Petición en frío: entrada → `result` | ~1.530 ms |
| Salida limpia del proceso tras cerrar stdin | ~870 ms |
| Tokens de entrada, mensaje mínimo (163 caracteres) sin `--setting-sources` | 2.769 |
| Tokens de entrada, mensaje mínimo con `--setting-sources project` | 1.012 |
| Tokens de entrada, petición típica (2.342 caracteres de contexto) | 1.926 |
| Tokens de salida, sugerencia de una expresión / de 3 líneas | 5 / 41 |

Precalentar el proceso ahorra ~0,6–0,7 s por sugerencia, que es justo lo que busca §3.

## Presupuesto resultante

Con ~950 tokens fijos por petición (600 de la CLI + el system prompt), para cumplir el criterio de aceptación
(mediana ≤ 2.000 tokens de entrada **medidos en `usage`**) el contexto del archivo tiene que quedarse en
~1.000 tokens ≈ 2.400 caracteres. Por eso el objetivo de §4 ("≤ 1.500 sin contar el system prompt") se aplica
sobre el total medido: `objetivo = 1.950 − sobrecarga`, con el límite duro de 2.500 de la spec para el mensaje.
