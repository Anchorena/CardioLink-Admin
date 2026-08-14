# AGENTS.md — CardioLink Admin

## Proyecto
CardioLink Admin es una aplicación médica en producción.
Stack: HTML/CSS/JavaScript + Supabase + GitHub Pages/PWA.

## Regla principal
`main` es PRODUCCIÓN. No modificar, commitear ni pushear a `main` salvo pedido explícito del usuario.

## Antes de trabajar
1. Inspeccionar solo los archivos relacionados con la tarea.
2. Leer `docs/CARDIOLINK_CONTEXT.md`.
3. Si la tarea toca arquitectura/sincronización, leer `docs/ARCHITECTURE.md`.
4. Si toca Caja, OS, copagos, colocaciones o permisos, leer `docs/BUSINESS_RULES.md`.
5. Antes de terminar, seguir `docs/QA.md`.

## Restricciones
- No reescribir la app completa.
- Preferir cambios incrementales y reversibles.
- Evitar tocar `app.js` si puede resolverse con un módulo independiente.
- No cambiar tablas Supabase ni SQL sin aprobación explícita.
- Nunca usar `service_role` en frontend.
- No borrar ni migrar datos clínicos/administrativos silenciosamente.
- No romper compatibilidad con datos existentes.
- No redefinir funciones globales sin verificar módulos que ya las interceptan.
- Documentar nuevos módulos y su orden de carga en `index.html`.
- No hacer commit/push automáticamente salvo pedido explícito.

## Áreas de alto riesgo
Login/sesión, sincronización Supabase, Historia Clínica, pacientes, Caja/Finanzas, permisos y Service Worker/PWA.

## Entrega esperada
Para cambios no triviales indicar:
- archivos tocados;
- riesgo;
- prueba realizada;
- cómo revertir;
- si afecta Supabase.
