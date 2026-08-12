/* =====================================================================
   CardioLink -- DESACTIVADO
   Este archivo completaba montoConsulta con el valor del arancel, pero
   ese campo alimenta "Ingresos cobrados" (plata asumida como ya
   cobrada), y el arancel es dinero todavia no cobrado. Eso mezclaba
   mal los dos conceptos. La app ya calculaba correctamente "cuanto
   deberia facturar" en Caja/reportes -> "Produccion a facturar",
   usando un campo separado (valorArancelEstimado) que este archivo
   nunca tuvo que tocar.
   Se deja el archivo vacio (en vez de borrarlo) para no romper el
   <script src="..."> del index.html. No hace nada.
   ===================================================================== */
