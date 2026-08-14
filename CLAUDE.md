# CLAUDE.md — CardioLink Admin

CardioLink Admin es una app médica real en producción.
Stack: HTML/CSS/JavaScript + Supabase + GitHub Pages/PWA.

## Forma de trabajo
- `main` = producción.
- Antes de editar, inspeccioná el código relacionado y sus dependencias.
- No hagas reescrituras completas.
- Preferí módulos pequeños y reversibles.
- Evitá modificar `app.js` si puede resolverse de otra forma.
- No cambies Supabase/SQL sin aprobación explícita.
- Nunca uses `service_role` en frontend.
- No borres datos clínicos ni administrativos.
- No hagas commit/push salvo pedido explícito.

## Contexto
Leé primero:
- `docs/CARDIOLINK_CONTEXT.md`

Según la tarea:
- arquitectura/sync → `docs/ARCHITECTURE.md`
- Caja/OS/permisos → `docs/BUSINESS_RULES.md`
- antes de cerrar → `docs/QA.md`

## Áreas sensibles
Login/sesión, sincronización, HC, pacientes, Caja/Finanzas, permisos y PWA.

## Criterio
Si el código y la documentación difieren:
- reglas funcionales/negocio: `docs/` es la fuente de verdad;
- estado de implementación: el repositorio es la fuente de verdad.
Señalá la discrepancia antes de cambiar comportamiento.
