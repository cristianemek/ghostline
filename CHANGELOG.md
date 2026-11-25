# Cambios

## 0.15.0

- Cambios: cuando lo que toca es cambiar algo ya escrito y no completar (un nombre que no existe, una línea
  fuera de su bucle), se propone ese cambio sobre el código, con `Tab` para aplicarlo y `Esc` para
  descartarlo, en lugar de sugerir código que no encaja. Si el cambio no se puede escribir, se dice en gris
  al final de la línea. Se apaga con `ghostline.changes`.
- Cambios y correcciones dentro de una línea se marcan en su sitio: se tacha solo lo que sobra y lo nuevo
  aparece al lado, en vez de repetir la línea entera a la derecha.
- Una sugerencia que termina justo después del tope de líneas conserva la línea que cierra su bloque.
- Mensaje del commit: un botón en la barra del panel de control de código fuente lo escribe a partir de los
  cambios preparados, o de todos si no hay ninguno, siguiendo el estilo de los últimos commits. Los archivos
  excluidos no se envían.
- La sentencia siguiente ya no sale pegada al final de la línea en la que está el cursor.
- Lo que el modelo se dice a sí mismo («Wait, that's wrong…»), sus explicaciones y sus marcas de fin de
  respuesta (`</s>`) ya no llegan al editor.
- En mitad de una línea se aprovecha la respuesta aunque el modelo retoque un espacio o devuelva solo lo que
  falta, y no se repite un paréntesis que ya está después del cursor.
- No se pide nada tras una línea que solo cierra un bloque.
- Las correcciones dejan en paz los errores de código a medio escribir (variables o imports sin usar).

## 0.14.0

- Popup de la barra de estado rehecho: icono y nombre, cada cifra en grande con su signo y su barra, y
  accesos directos (pausar, cambiar de modo, consumo, últimas sugerencias, ajustes).
- Con API key, la barra y el popup muestran lo gastado hoy en lugar de la parte de la sesión. El aviso de
  que se factura por uso pasa a ser informativo y se da una sola vez.
- Licencia MIT. ghostline se presenta como lo que es: una extensión que usa la CLI de tu agente de IA
  (de momento, Claude Code), con la sesión que tengas en ella.
- Colores del icono alineados con los del popup.

## 0.13.1

- JSX, HTML y plantillas: lo que sigue a una etiqueta abierta queda un nivel más adentro y su cierre
  vuelve al nivel de la apertura (antes, la lista dentro de un `<ul>` salía alineada con él).

## 0.13.0

- La barra de estado lleva el icono de ghostline (el fantasma sobre su línea) en lugar del nombre.

## 0.12.0

- Sonnet con esfuerzo `low` pasa a ser la configuración por defecto: más rápido y más regular.
- La CLI se lanza en una carpeta vacía dentro del almacenamiento por usuario de VS Code (antes, en el
  directorio temporal) y nunca si esa carpeta contiene algo.
- Aviso cuando `ANTHROPIC_BASE_URL` manda las peticiones a un servidor que no es el de Anthropic.
- El log no muestra nada que parezca una clave o un token.
- El índice del proyecto no sigue enlaces simbólicos que salgan del proyecto y lee los archivos por tandas.
- El texto tomado de otros archivos (índice, declaraciones, mensajes del compilador) no puede alterar la
  estructura del prompt, y los mensajes del compilador se envían sin rutas del disco.

## 0.11.0

- Correcciones: cuando el compilador marca errores junto al cursor, se propone el bloque reescrito.

## 0.10.0

- Índice del proyecto: las declaraciones de los archivos de código se envían con cada petición.
- Ajustes reorganizados en dos grupos.

## 0.9.0

- En mitad de una línea se pide la línea entera y se deriva la inserción.
- Los ejemplos aceptados dejan de enviarse por defecto.
- Comando para ver las últimas sugerencias.

## 0.8.0

- Barra de estado con el tope diario y la parte de la sesión de Claude gastada. Icono.

## 0.7.0

- El contexto de símbolos incluye los campos de los tipos.

## 0.6.1

- Sugerencias también en mitad de una línea.
