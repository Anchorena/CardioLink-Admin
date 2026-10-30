-- CardioLink · Documentos V2A / F3 — QA TRANSACCIONAL del límite de tasa persistente (ejecutar DESPUÉS de aplicar ..._limites_v1.sql en STAGING).
-- NO EJECUTAR sin autorización explícita. Una sola transacción implícita que SIEMPRE se revierte: termina en un error intencional con el informe
-- ('RESULTADO LIMITES V2A: aprobadas=N, fallidas=M, total=T' + lista de fallas). Sin BEGIN/COMMIT explícitos a propósito.

create temp table _res (n serial, prueba text, ok boolean, detalle text) on commit drop;
grant all on _res to public; grant usage on sequence _res_n_seq to public;

create function pg_temp.como(p_rol text, p_sql text) returns text language plpgsql as $f$
declare v text;
begin
  execute 'set local role ' || quote_ident(p_rol);
  begin execute p_sql into v; execute 'reset role'; return 'OK' || coalesce(': ' || v, '');
  exception when others then execute 'reset role'; return 'ERR: ' || sqlerrm; end;
end $f$;
create function pg_temp.anota(p_prueba text, p_ok boolean, p_detalle text default null) returns void language sql as
$f$ insert into _res (prueba, ok, detalle) values (p_prueba, coalesce(p_ok, false), p_detalle) $f$;

do $$
declare r text; i int; v boolean; antes int; despues int; fallo boolean;
begin
  -- 1) ventana: hasta el máximo true, después false
  perform pg_temp.anota('1a. los primeros 3 intentos (máx. 3) pasan',
    public.cardiolink_verificacion_limitar_v1('ip:qa1', 3, 600) and public.cardiolink_verificacion_limitar_v1('ip:qa1', 3, 600) and public.cardiolink_verificacion_limitar_v1('ip:qa1', 3, 600), null);
  perform pg_temp.anota('1b. el 4.º y el 5.º se rechazan', not public.cardiolink_verificacion_limitar_v1('ip:qa1', 3, 600) and not public.cardiolink_verificacion_limitar_v1('ip:qa1', 3, 600), null);
  perform pg_temp.anota('1c. el contador es persistente (queda en la tabla)', (select intentos from public.cardiolink_verificacion_limites where clave = 'ip:qa1') = 5, null);
  -- 2) claves independientes
  perform pg_temp.anota('2. otra clave no se ve afectada', public.cardiolink_verificacion_limitar_v1('ip:qa2', 3, 600), null);
  -- 3) la ventana vence y reinicia
  update public.cardiolink_verificacion_limites set ventana_inicio = now() - interval '11 minutes' where clave = 'ip:qa1';
  perform pg_temp.anota('3a. vencida la ventana, el intento vuelve a pasar', public.cardiolink_verificacion_limitar_v1('ip:qa1', 3, 600), null);
  perform pg_temp.anota('3b. y el contador se reinició en 1', (select intentos from public.cardiolink_verificacion_limites where clave = 'ip:qa1') = 1, null);
  -- 4) parámetros inválidos
  for i in 1..9 loop
    fallo := false;
    begin
      perform case i
        when 1 then public.cardiolink_verificacion_limitar_v1(null, 3, 60)
        when 2 then public.cardiolink_verificacion_limitar_v1('IP:MAYUS', 3, 60)
        when 3 then public.cardiolink_verificacion_limitar_v1('ip:' || repeat('a', 90), 3, 60)
        when 4 then public.cardiolink_verificacion_limitar_v1('ip:ok', 0, 60)
        when 5 then public.cardiolink_verificacion_limitar_v1('ip:ok', 3, 0)
        when 6 then public.cardiolink_verificacion_limitar_v1('ip:ok', 3, 100000)
        when 7 then public.cardiolink_verificacion_limitar_v1('ip:ok', 200000, 60)
        when 8 then public.cardiolink_verificacion_limitar_v1('ip:ok;drop', 3, 60)
        else public.cardiolink_verificacion_limitar_v1('', 3, 60) end;
    exception when others then fallo := true; end;
    perform pg_temp.anota('4.' || i || ' parámetro inválido rechazado', fallo, null);
  end loop;
  -- 5) privilegios
  r := pg_temp.como('anon', $q$select public.cardiolink_verificacion_limitar_v1('ip:x', 3, 60)::text$q$);
  perform pg_temp.anota('5a. anon NO puede ejecutar la función', r like 'ERR:%', r);
  r := pg_temp.como('authenticated', $q$select public.cardiolink_verificacion_limitar_v1('ip:x', 3, 60)::text$q$);
  perform pg_temp.anota('5b. authenticated NO puede ejecutar la función', r like 'ERR:%', r);
  r := pg_temp.como('service_role', $q$select public.cardiolink_verificacion_limitar_v1('ip:svc', 3, 60)::text$q$);
  perform pg_temp.anota('5c. service_role SÍ puede ejecutarla', r like 'OK:%', r);
  r := pg_temp.como('authenticated', 'select count(*)::text from public.cardiolink_verificacion_limites');
  perform pg_temp.anota('5d. el cliente no lee ni escribe la tabla', r like 'ERR:%' and pg_temp.como('anon', 'select count(*)::text from public.cardiolink_verificacion_limites') like 'ERR:%', r);
  perform pg_temp.anota('5e. SECURITY DEFINER con search_path fijo', (select prosecdef and array_to_string(proconfig, ',') like '%search_path=pg_catalog, public%' from pg_proc where proname = 'cardiolink_verificacion_limitar_v1'), null);
  -- 6) la tabla no crece sin límite: limpieza acotada (probabilística; 700 llamadas => prob. de no limpiar < 1e-6)
  insert into public.cardiolink_verificacion_limites (clave, ventana_inicio, intentos) select 'ip:viejo' || g, now() - interval '3 days', 1 from generate_series(1, 200) g;
  select count(*) into antes from public.cardiolink_verificacion_limites where clave like 'ip:viejo%';
  for i in 1..700 loop perform public.cardiolink_verificacion_limitar_v1('ip:carga' || (i % 5), 100000, 60); end loop;
  select count(*) into despues from public.cardiolink_verificacion_limites where clave like 'ip:viejo%';
  perform pg_temp.anota('6a. las claves viejas se purgan de forma acotada', despues < antes, 'antes=' || antes || ' despues=' || despues);
  perform pg_temp.anota('6b. las claves vigentes no se purgan', (select count(*) from public.cardiolink_verificacion_limites where clave like 'ip:carga%') = 5, null);
  -- 6c) la limpieza nunca borra una ventana vigente aunque esté entre las candidatas y respeta el tope de 50 por pasada
  perform pg_temp.anota('6c. la limpieza no borra filas recientes', (select count(*) from public.cardiolink_verificacion_limites where ventana_inicio >= now() - interval '1 day') >= 6, null);
  -- 6d) tope del contador (sin desborde de entero) y sigue denegando
  update public.cardiolink_verificacion_limites set intentos = 1000000 where clave = 'ip:carga0';
  perform pg_temp.anota('6d. el contador tiene tope y sigue denegando', not public.cardiolink_verificacion_limitar_v1('ip:carga0', 100000, 60) and (select intentos from public.cardiolink_verificacion_limites where clave = 'ip:carga0') = 1000000, null);
  perform pg_temp.anota('7. no guarda IP en claro ni datos clínicos (sólo clave opaca y contadores)', (select count(*) from information_schema.columns where table_name = 'cardiolink_verificacion_limites') = 3, null);
end $$;

do $$
declare v_f text; v_ap int; v_fa int; v_to int;
begin
  select count(*) filter (where ok), count(*) filter (where not ok), count(*) into v_ap, v_fa, v_to from _res;
  select string_agg(n || ' ' || prueba || ' => ' || coalesce(left(detalle, 200), ''), E'\n' order by n) into v_f from _res where not ok;
  raise exception E'RESULTADO LIMITES V2A (esta transacción se revierte): aprobadas=%, fallidas=%, total=%\n%', v_ap, v_fa, v_to, coalesce(v_f, 'sin fallas');
end $$;
