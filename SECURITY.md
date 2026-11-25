# Seguridad

## Avisar de un fallo

Con «Report a vulnerability», en la pestaña *Security* del repositorio (el aviso es privado). No abras un
issue público con los detalles.

## Tus credenciales de Claude

ghostline no las toca. No hay servidor ni cuenta del autor por medio: cada instalación habla solo con la CLI
de Claude Code de ese equipo, y es la CLI la que guarda y usa la sesión.

- No lee `~/.claude` ni el almacén de credenciales del sistema, y no tiene código de red: del runtime de Node
  solo usa `fs`, `path`, `os`, `crypto`, `string_decoder` y `child_process`. Sin dependencias de runtime.
- La CLI se localiza en `ghostline.cliPath` (solo de tus ajustes de usuario, nunca de los del repositorio) o
  en las carpetas absolutas del `PATH`, y se lanza con su ruta completa y sin shell.
- La CLI obedece un `.claude/settings.json` que encuentre en su carpeta de trabajo (podría mandar las
  peticiones, y la sesión con ellas, a otro servidor, o ejecutar comandos). Por eso nunca se lanza en tu
  proyecto: se lanza en una carpeta propia dentro del almacenamiento por usuario de VS Code, y solo si está
  vacía. Si no lo está, no se lanza ahí y se avisa.
- Las variables de entorno llegan a la CLI como están en el editor y nunca se escriben en el log. Si
  `ANTHROPIC_BASE_URL` apunta a un servidor que no es el de Anthropic, ghostline lo dice antes de la primera
  petición.
- Lo que la CLI imprime al fallar pasa al log sin nada que parezca una clave o un token.

## Lo que puede hacer un repositorio que abras

- Hacer a ghostline más conservador: añadir exclusiones, desactivarlo, pedir el modo manual.
- Nada más. El modelo, la ruta de la CLI, el tope diario, el contexto de otros archivos y el log de prompts
  solo se leen de tus ajustes de usuario. Y ghostline no funciona en áreas de trabajo sin confianza.

## Lo que sale de tu equipo

A Anthropic, a través de la CLI: el contexto alrededor del cursor del archivo que editas y, si no lo
desactivas, nombres y tipos declarados en otros archivos del proyecto. Cuando pides un mensaje de commit, el
diff de los cambios que vas a confirmar y el título de tus últimos commits. Nunca nada de un archivo
excluido, ni de lo que haya detrás de un enlace simbólico que salga del proyecto.

## Límites que conviene conocer

- El archivo que editas se envía tal cual está alrededor del cursor. Una clave pegada en un archivo que no
  esté excluido viaja con ese contexto, y con el diff si pides el mensaje de un commit que la incluye.
- El texto de otros archivos puede intentar influir en la sugerencia. Como el modelo no tiene herramientas,
  lo más que consigue es una mala sugerencia, que tú decides si aceptas. Léela antes de pulsar `Tab`.
- La CLI incluye por su cuenta en cada petición datos de tu sesión (el correo de la cuenta), igual que en
  cualquier otro uso de Claude Code.
- Las últimas 40 sugerencias de cada proyecto se guardan sin cifrar en el almacenamiento de VS Code de tu
  usuario.
