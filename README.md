# Rumat Parfums: tienda con Vercel + Neon

Catálogo, carrito, pedido por WhatsApp y administrador con contraseña.
Los perfumes, fotos y videos se guardan en la base de datos de Neon.

## Cómo publicarla (unos 15 minutos)

1. **Neon (base de datos):** creá una cuenta en neon.com, hacé "New Project" y copiá la
   **Connection string** (empieza con `postgresql://`). Las tablas se crean solas.
2. **GitHub:** creá un repositorio nuevo y subí esta carpeta completa.
3. **Vercel (hosting):** en vercel.com elegí "Add New > Project" e importá el repositorio.
   - Framework Preset: **Other**.
   - En "Environment Variables" cargá:
     - `DATABASE_URL`: la connection string de Neon.
     - `ADMIN_EMAIL`: el correo de la cuenta del dueño (la única que ve el administrador).
     - `ADMIN_PASSWORD`: la contraseña de esa cuenta.
     - `GMAIL_USER` y `GMAIL_APP_PASSWORD`: el Gmail desde el que se mandan los correos de recuperación de contraseña y su "contraseña de aplicación" de 16 letras (Cuenta de Google > Seguridad > Verificación en 2 pasos > Contraseñas de aplicaciones).
     - `SESSION_SECRET`: un texto largo y al azar (para firmar las sesiones).
4. Tocá **Deploy**. Cuando termine, abrí la dirección que te da Vercel.
5. Para entrar al administrador, tocá "Admin" al final de la página (o agregá `#admin` a la dirección).
6. **Dominio propio:** en Vercel, Settings > Domains.

## Cosas a saber

- Entrar al administrador: tocá "Ingresar" (arriba a la derecha), usá `ADMIN_EMAIL` y `ADMIN_PASSWORD`, y después "Ir al administrador".
- Cambiar la contraseña del dueño: cambiá `ADMIN_PASSWORD` en Vercel y hacé "Redeploy".
- Pedidos: cada pedido queda guardado. En el administrador, "Marcar pagado" suma el monto a los puntos del cliente (10% de descuento cada $159.000).
- Las fotos se achican solas. Los videos pueden pesar hasta 4 MB (límite de Vercel).
- Cualquier cambio en el administrador se ve al instante para todos los visitantes.
- El stock no baja solo con cada pedido: se actualiza desde el administrador.
- Los clientes pueden crear cuenta (opcional) para sumar puntos. Si olvidan la contraseña, se les envía un enlace por mail (vale 1 hora). Gmail permite unos 500 correos por día.
- El catálogo muestra 12 perfumes por página, y los que no tienen stock van siempre al final.
- Los pagos se coordinan por WhatsApp (transferencia o efectivo). El costo del envío lo calcula el local y lo confirma por WhatsApp.
- El número de WhatsApp está en `public/index.html` (variable `WA`).

## Archivos

- `public/index.html`: la tienda (lo que ven los clientes y el administrador).
- `api/index.js`: el servidor (login, catálogo, fotos y videos).
- `vercel.json`, `package.json`: configuración.
