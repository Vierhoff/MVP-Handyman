import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import localtunnel from 'localtunnel';

dotenv.config();

const app = express();
app.use(express.json());

const {
    VERIFY_TOKEN,
    WHATSAPP_TOKEN,
    PHONE_NUMBER_ID,
    MOCK_PROFESSIONAL_NUMBER
} = process.env;

// --- IN-MEMORY DATABASE (MVP) ---
interface UserState {
    step: number;
    category?: string;
    description?: string;
}
const userSessions: Record<string, UserState> = {};
const pendingJobs: Record<string, any> = {};

const PORT = process.env.PORT || 3000;

// --- Funciones Auxiliares ---
async function sendMessage(to: string, text: string) {
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        console.error("Falta WHATSAPP_TOKEN o PHONE_NUMBER_ID en el archivo .env");
        return;
    }

    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: to,
                text: { body: text },
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
                },
            }
        );
    } catch (error: any) {
        console.error("Error enviando mensaje a Meta:", error.response?.data || error.message);
    }
}

// --- Endpoints del Webhook ---

// 1. Verificación del Webhook (Lo llama Meta cuando configuras la URL en el panel)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK VERIFICADO EXITOSAMENTE!');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

// 2. Recepción de mensajes (Lo llama Meta cuando alguien escribe al bot)
app.post('/webhook', async (req, res) => {
    const body = req.body;
    console.log("=== RAW WEBHOOK PAYLOAD ===");
    console.log(JSON.stringify(body, null, 2));
    console.log("===========================");

    // Verificar si es un evento de WhatsApp
    if (body.object) {
        if (
            body.entry &&
            body.entry[0].changes &&
            body.entry[0].changes[0] &&
            body.entry[0].changes[0].value.messages &&
            body.entry[0].changes[0].value.messages[0]
        ) {
            const message = body.entry[0].changes[0].value.messages[0];
            
            // Ignoramos mensajes que no sean de texto (por ahora en el MVP)
            if (message.type !== 'text') {
                res.sendStatus(200);
                return;
            }

            const from = message.from; // Número del remitente (ej: 54911...)
            const text = message.text.body.trim();
            const textLower = text.toLowerCase();

            console.log(`Mensaje recibido de ${from}: ${text}`);

            // --- FLUJO DEL PROFESIONAL (Simulado) ---
            if (MOCK_PROFESSIONAL_NUMBER && from === MOCK_PROFESSIONAL_NUMBER && textLower.startsWith('aceptar')) {
                const jobId = text.split(' ')[1]; // Ej: ACEPTAR 54911...
                if (jobId && pendingJobs[jobId]) {
                    const job = pendingJobs[jobId];
                    await sendMessage(from, `✅ Has aceptado el trabajo de ${job.category}. Contacta al cliente al wa.me/${jobId}`);
                    
                    // Avisar al cliente
                    await sendMessage(jobId, `¡Buenas noticias! 🎉 Un profesional ha aceptado tu solicitud. Se pondrá en contacto contigo a la brevedad.`);
                    
                    delete pendingJobs[jobId]; // Limpiar el trabajo
                } else {
                    await sendMessage(from, `❌ No se encontró ese trabajo o ya fue tomado.`);
                }
                res.sendStatus(200);
                return;
            }


            // --- FLUJO DEL CLIENTE (FFF) ---
            if (!userSessions[from]) {
                userSessions[from] = { step: 0 };
            }

            const session = userSessions[from];

            // Reiniciar flujo
            if (textLower === 'cancelar' || textLower === 'hola' || textLower === 'menu') {
                session.step = 1;
                const response = `¡Hola! Soy tu asistente de reparaciones. 🛠️\n\n¿Qué servicio necesitas hoy? Responde con el *número* de la opción:\n\n1️⃣ Plomero\n2️⃣ Gasista\n3️⃣ Electricista\n4️⃣ Albañil\n\n*(Escribe 'cancelar' en cualquier momento para salir)*`;
                await sendMessage(from, response);
                res.sendStatus(200);
                return;
            }

            // Máquina de estados
            switch (session.step) {
                case 0:
                    session.step = 1;
                    await sendMessage(from, `¡Hola! Soy tu asistente de reparaciones. 🛠️\n\n¿Qué servicio necesitas hoy? Responde con el *número* de la opción:\n\n1️⃣ Plomero\n2️⃣ Gasista\n3️⃣ Electricista\n4️⃣ Albañil`);
                    break;

                case 1:
                    const categorias = {
                        '1': 'Plomería',
                        '2': 'Gas',
                        '3': 'Electricidad',
                        '4': 'Albañilería'
                    };
                    const seleccion = categorias[text as keyof typeof categorias];
                    
                    if (seleccion) {
                        session.category = seleccion;
                        session.step = 2;
                        await sendMessage(from, `Elegiste *${seleccion}*. Excelente.\n\nPor favor, *describe brevemente tu problema* y dime la *dirección* aproximada a donde debería ir el profesional (ej: Se rompió un caño en la cocina, Palermo).`);
                    } else {
                        await sendMessage(from, `❌ Opción no válida. Por favor responde solo con el número (1, 2, 3 o 4).`);
                    }
                    break;

                case 2:
                    session.description = text;
                    pendingJobs[from] = {
                        category: session.category,
                        description: session.description
                    };

                    await sendMessage(from, `¡Perfecto! Hemos recibido tu solicitud para *${session.category}*.\n\n📝 Detalle: "${session.description}"\n\n🔎 Estamos buscando un profesional disponible. Te avisaremos por aquí apenas tengamos a alguien confirmado.`);
                    
                    // Simular búsqueda enviando mensaje al profesional
                    if (MOCK_PROFESSIONAL_NUMBER) {
                        await sendMessage(MOCK_PROFESSIONAL_NUMBER, `🚨 *¡Nuevo Trabajo Disponible!* 🚨\n\n*Rubro:* ${session.category}\n*Detalle:* ${session.description}\n\nPara aceptar este trabajo, responde exactamente con:\nACEPTAR ${from}`);
                    }

                    session.step = 0;
                    break;

                default:
                    session.step = 0;
                    break;
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// Iniciar servidor
app.listen(PORT, async () => {
    console.log('\n==================================================');
    console.log(`🚀 Servidor Webhook iniciado en el puerto ${PORT}`);
    
    // Solo usamos localtunnel en desarrollo
    if (process.env.NODE_ENV !== 'production') {
        console.log('Generando URL pública de túnel...');
        try {
            const tunnel = await localtunnel({ port: Number(PORT) });
            console.log(`\n✅ URL DEL WEBHOOK (Copia y pega esto en Meta):`);
            console.log(`➡️  ${tunnel.url}/webhook  ⬅️`);
            console.log('\nToken de Verificación (Copia y pega esto en Meta):');
            console.log(`➡️  ${VERIFY_TOKEN}  ⬅️`);
            console.log('==================================================\n');
            
            tunnel.on('close', () => {
                console.log('Túnel cerrado.');
            });
        } catch (err) {
            console.error('Error iniciando localtunnel:', err);
        }
    } else {
        console.log('✅ Modo Producción activado.');
        console.log('==================================================\n');
    }
});
