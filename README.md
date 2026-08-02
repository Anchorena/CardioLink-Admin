# CardioLink Admin v4.0.7 FINAL

Sistema de gestión de consultorio médico con agenda, pacientes, pendientes, caja diaria, reportes, perfiles, convenios y aranceles configurables.

## Producción estimada
Los aranceles se fijan automáticamente en las nuevas atenciones según cobertura, prestación y vigencia. Los totales económicos permanecen ocultos hasta que Matías o un Administrador solicitan el cálculo desde Configuración → Coberturas y valores.

## Importar evoluciones históricas desde Medicloud (v4.0.7)

1. Ingresar con perfil Matías/Administrador.
2. Abrir **Historia clínica**.
3. Presionar **Importar evoluciones Medicloud**.
4. Seleccionar el archivo `.xls`, `.xlsx` o `.csv` exportado desde Medicloud.
5. Revisar la vista previa y elegir el profesional autor.
6. Confirmar la importación.

La vinculación se realiza principalmente por DNI. La fecha y hora originales se conservan. No se crean turnos, caja ni agenda. El sistema evita duplicados y permite deshacer el último lote importado.

## Documentos profesionales (v4.0.7)
Cada profesional puede configurar su identidad desde **Historia clínica → Mi membrete y firma**. El Administrador también puede hacerlo desde **Configuración → Profesionales**.

Las recetas, órdenes y certificados se crean desde la Historia Clínica o la ficha del paciente. Se guardan solo cuando contienen texto y se imprimen con los datos, logo, matrículas y firma del profesional emisor.

La firma subida es una imagen gráfica para documentos impresos; no constituye una firma digital certificada.


## v4.0.7
La HC está habilitada para todos los médicos. Las notas internas son privadas por profesional. El importador Medicloud se encuentra en Historia clínica y Pacientes.
