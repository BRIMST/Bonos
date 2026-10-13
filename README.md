# Bono de Contribución Diaria — Vercel + Firebase

Aplicación web para registro diario, revisión manual de pagos y administración de participantes. Está preparada para desplegarse en Vercel y usa Firebase Firestore para registros y comprobantes (no usa Firebase Storage).

## Reglas que aplica el sistema

- Valor por registro: COP $5.000 (configurable en `server.js`).
- Se registra un número de exactamente cinco cifras como texto; se conservan ceros iniciales (`00523`). Se permiten números repetidos entre participantes.
- La hora de referencia se calcula en el servidor con la zona `America/Bogota`.
- La recepción cierra a las 7:00 p. m. No se aceptan registros a partir de esa hora.
- Un registro solo participa en la jornada de su fecha y únicamente si el administrador verifica el pago antes de las 7:00 p. m. de ese mismo día.
- Los pagos pendientes al cierre no participan ni se trasladan a otra jornada. Para otro día se necesita un nuevo registro y un nuevo pago.
- El Excel y el CSV oficial incluyen únicamente participaciones aceptadas/verificadas. El panel administrativo también permite consultar registros pendientes o rechazados.
- No ejecuta automáticamente el sorteo ni verifica transferencias bancarias.

## Despliegue en Vercel

### 1. Crear Firebase

1. Crea un proyecto en [Firebase Console](https://console.firebase.google.com/).
2. Activa **Cloud Firestore** (no necesitas Cloud Storage).
3. En la configuración del proyecto, crea una clave de cuenta de servicio y guarda el JSON de forma privada.

### 2. Subir el proyecto a GitHub

1. Descomprime el ZIP y sube el contenido a un repositorio privado de GitHub.
2. No subas `.env`, claves de Firebase ni credenciales. El `.gitignore` ya excluye `.env`.
3. En Vercel, importa ese repositorio. Framework preset: **Other**; no hace falta comando de build.

### 3. Configurar variables de entorno en Vercel

En **Project → Settings → Environment Variables**, agrega estas variables para Production (y Preview si lo necesitas):

- `NODE_ENV` = `production`
- `ADMIN_PASSWORD` = una contraseña administrativa larga, única y difícil de adivinar
- `SESSION_SECRET` = una cadena aleatoria de al menos 32 caracteres
- `FIREBASE_SERVICE_ACCOUNT_JSON` = el JSON completo de la cuenta de servicio en una sola línea
- `BREB_LABEL` = texto que identifica la forma de pago, por ejemplo `Llave Bre-B`
- `BREB_VALUE` = la llave/dato que quieres mostrar públicamente

Después de agregar las variables, vuelve a desplegar (Redeploy). Nunca compartas la cuenta de servicio ni publiques la contraseña.

### 4. Abrir la aplicación

- Página pública: la URL de tu proyecto en Vercel.
- Panel administrador: añade `/admin` a esa URL.
- La página pública muestra el dato de pago que configures en `BREB_VALUE`. Verifica que el destinatario sea correcto antes de publicarla.

## Ejecución local opcional

Requiere Node.js 20 o superior.

1. Copia `.env.example` a `.env` y completa las variables.
2. Ejecuta `npm install`.
3. Ejecuta `npm start`.
4. Abre `http://localhost:3000` y `http://localhost:3000/admin`.

## Uso del panel

1. Inicia sesión con `ADMIN_PASSWORD`.
2. Abre el comprobante para comprobar la transferencia.
3. Marca el pago como **Verificado** antes de las 7:00 p. m. del mismo día para aceptar esa participación.
4. Descarga el Excel o CSV para obtener la lista oficial de participantes aceptados.

## Consideraciones técnicas y de seguridad

- El inicio de sesión usa una cookie firmada, adecuada para el modelo serverless de Vercel; no depende de sesiones guardadas en memoria del proceso.
- Los comprobantes se guardan en Firestore (colección `receipts`) y solo se sirven a una sesión de administrador.
- Límite de comprobante: 800 KB (tope de 1 MiB por documento de Firestore). Las imágenes se comprimen automáticamente en el navegador; los PDF deben pesar menos de 780 KB. Formatos: JPG, PNG y PDF.
- Firestore puede pedir un índice compuesto para algunas consultas; si ocurre, sigue el enlace de creación de índice del error de Firebase.
- La cuenta de servicio necesita permisos para Firestore.
- Antes de producción, considera protección CSRF adicional, MFA, registro de auditoría, copias de seguridad y una política de retención/borrado de comprobantes.
- Verifica asesoría legal y las autorizaciones aplicables en Colombia antes de cobrar contribuciones vinculadas a premios o resultados de lotería. Llamarlo “bono de contribución” no garantiza que el esquema esté exento de regulación.

## Cambios de la versión 1.2

- Panel admin: selector de jornada, resumen (registrados, aceptados, pendientes, rechazados, recaudo) y exportación Excel/CSV de cualquier fecha.
- Las consultas ya no requieren índices compuestos de Firestore.
- Límite de intentos en el login (10 / 15 min) y en registros (20 / 15 min por IP).
- Se valida el contenido real del comprobante (JPG, PNG o PDF), no solo el tipo declarado.
- Una participación aceptada queda congelada al cerrar la jornada.
- Los errores internos ya no exponen detalles al público.

## Llave Bre-B y contraseña desde el panel (v1.3)

- En `/admin`, sección **Configuración**, editas el nombre y la llave Bre-B que ve el público, y cambias la contraseña. Se guardan en Firestore (colección `settings`); la contraseña se guarda con hash (scrypt), nunca en texto plano.
- `ADMIN_PASSWORD` solo se usa como contraseña inicial hasta que la cambies. `BREB_LABEL` y `BREB_VALUE` son opcionales.
- Al cambiar la contraseña se cierran las demás sesiones abiertas.
- `SESSION_SECRET`, `FIREBASE_*` siguen siendo variables de entorno (son técnicas, no deben editarse desde la web).

## Diseño (v1.4)

Diseño responsive para teléfono, tableta y escritorio: boleto con los 5 dígitos en vivo, cuenta regresiva al cierre de las 7:00 p. m. y, tras enviar el registro, una tarjeta animada con confeti: «¡Muchas gracias por tu apoyo! Buena suerte en el sorteo». Respeta la preferencia de «reducir movimiento» del dispositivo. En el admin, la tabla pasa a tarjetas en el teléfono.
