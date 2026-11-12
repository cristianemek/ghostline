# ghostline

Autocompletado inline (texto fantasma) para VS Code con Claude. No trae modelo ni servidor propios: lanza la
CLI de [Claude Code](https://claude.com/claude-code) que ya tienes instalada, con la sesión que tengas
iniciada en ella.

> Extensión no oficial, sin relación con Anthropic. Lo que consume cuenta contra tu plan de Claude y está
> sujeto a los términos de Anthropic.

## Requisitos

- VS Code 1.144 o posterior.
- Claude Code instalado y con la sesión iniciada (`claude` y, dentro, `/login`).

## Instalación

```
npm install
npm run package
code --install-extension ghostline-0.13.1.vsix
```

Si la barra de estado dice «sin CLI», pon en `ghostline.cliPath` la ruta del ejecutable (lo que devuelva
`which claude` o `where claude`).

## Uso

- Escribe y para un momento: la sugerencia aparece en gris. `Tab` la acepta, `Esc` la descarta.
- `Alt+\` (`Alt+ç` en teclado español) la pide a mano.
- **Correcciones**: cuando el compilador marca errores junto al cursor, ghostline propone el bloque corregido
  encima del código. `Tab` lo aplica, `Esc` lo descarta.
- **Barra de estado**: junto al fantasma, `8% · Claude 0,5%` es lo que llevas de tu tope diario y la parte
  de una sesión de Claude (5 h) que se ha llevado ghostline. Con un clic: pausar, cambiar de modo, ver el
  consumo, el log y las últimas sugerencias.

## Ajustes principales

| Ajuste | Por defecto | |
|---|---|---|
| `ghostline.model` | `sonnet` | `haiku` gasta unas 12 veces menos por petición, pero tarda más. |
| `ghostline.triggerMode` | `auto` | `manual`: solo sugiere con el atajo. |
| `ghostline.debounceMs` | `600` | Pausa al teclear antes de pedir una sugerencia. |
| `ghostline.dailyRequestLimit` | `1500` | Tope de peticiones al día. |
| `ghostline.context.symbols` | `true` | Enviar también declaraciones de otros archivos del proyecto. |
| `ghostline.corrections` | `true` | Proponer correcciones. |
| `ghostline.excludePatterns` | `.env`, claves… | Archivos de los que nunca se envía nada. |

El resto está en *Ajustes → ghostline → Avanzado*.

## Privacidad y seguridad

- **Qué se envía a Anthropic** (lo envía la CLI): hasta 60 líneas antes y 20 después del cursor y, con
  `ghostline.context.symbols`, nombres y tipos declarados en otros archivos del proyecto. Nunca valores ni
  cuerpos de función.
- **Qué no se envía nunca**: los archivos excluidos (`.env`, claves, credenciales…). Un repositorio puede
  añadir exclusiones, no quitarlas.
- **Credenciales**: ghostline no lee, guarda ni transmite tu sesión ni tus claves; solo las usa la CLI de
  Claude Code. No tiene servidor, telemetría ni conexiones de red propias.
- La CLI se lanza sin shell, sin herramientas (el modelo no puede leer, editar ni ejecutar nada) y en una
  carpeta vacía propia, nunca en tu proyecto: un repositorio no puede cambiar qué se ejecuta ni a dónde van
  las peticiones.
- Solo funciona en áreas de trabajo de confianza.
- En tu equipo quedan, dentro del almacenamiento de VS Code, los contadores de uso y las últimas 40
  sugerencias de cada proyecto.

El detalle, y cómo avisar de un fallo de seguridad, en `SECURITY.md`.

## Desarrollo

```
npm run check      # tipos, lint y tests (CLI simulada: no gasta tokens)
npm run test:e2e   # VS Code real en un perfil aislado, con la CLI simulada
npm run package    # genera el .vsix
```

Sin dependencias de runtime.
