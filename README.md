# CardioLink Admin v4.0.9.6 — Estabilización de Historia Clínica

Sistema de gestión de consultorio médico con agenda, pacientes, pendientes, caja diaria, reportes, perfiles, convenios y aranceles configurables.

## Producción estimada
Los aranceles se fijan automáticamente en las nuevas atenciones según cobertura, prestación y vigencia. Los totales económicos permanecen ocultos hasta que Matías o un Administrador solicitan el cálculo desde Configuración → Coberturas y valores.

## Importar evoluciones históricas desde otra app (v4.0.9.6)

1. Ingresar con perfil Matías/Administrador.
2. Abrir **Historia clínica**.
3. Presionar **Importar evoluciones de otra app**.
4. Seleccionar el archivo `.xls`, `.xlsx` o `.csv` exportado desde otra app.
5. Revisar la vista previa y elegir el profesional autor.
6. Confirmar la importación.

La vinculación se realiza principalmente por DNI. La fecha y hora originales se conservan. No se crean turnos, caja ni agenda. El sistema evita duplicados y permite deshacer el último lote importado.

## Documentos profesionales (v4.0.9.6)
Cada profesional puede configurar su identidad desde **Historia clínica → Mi membrete y firma**. El Administrador también puede hacerlo desde **Configuración → Profesionales**.

Las recetas, órdenes y certificados se crean desde la Historia Clínica o la ficha del paciente. Se guardan solo cuando contienen texto y se imprimen con los datos, logo, matrículas y firma del profesional emisor.

La firma subida es una imagen gráfica para documentos impresos; no constituye una firma digital certificada.


## v4.0.9.6
La HC está habilitada para todos los médicos. Las notas internas son privadas por profesional. El importador de evoluciones se encuentra en Historia clínica y Pacientes.


## v4.0.9.6 — búsqueda y panel de evolución

- La Historia Clínica muestra todos los pacientes desde el ingreso, ordenados alfabéticamente y paginados de 50 en 50.
- La búsqueda recorre toda la base sin el límite anterior de 80 resultados y prioriza coincidencias exactas de DNI.
- El panel de evolución incorpora DNI, fecha de nacimiento, edad, sexo, cobertura, afiliado, teléfono y email.
- Acciones rápidas para copiar DNI, teléfono, email o todos los datos, además de abrir WhatsApp o correo.
- El motivo de consulta pasa a ser un campo compacto y la narrativa clínica dispone de mayor espacio.

## Flujo de consulta y documentos rápidos (v4.0.9.6)

Al abrir desde Agenda, el turno pasa a **En consulta**. Al guardar una evolución clínica vinculada, pasa a **Atendido**. Los nuevos tipos documentales cargan borradores editables y se guardan únicamente por acción explícita del profesional.

## Dictado clínico por campo (v4.0.9.6)

Los campos clínicos y documentos muestran un botón **🎤 Dictar**. El reconocimiento usa `es-AR`, agrega el texto donde está el cursor y requiere guardado manual. CardioLink no conserva audio. Para probarlo, usar la app publicada por HTTPS; si el navegador no ofrece reconocimiento integrado, usar el micrófono del teclado del dispositivo.


## v4.0.9.6
Incluye acceso asistido a RCTA y scroll independiente de los listados de pacientes.
