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
    name?: string;
    category?: string;
    urgency?: string;
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
            
            // Ignoramos mensajes que no sean de texto, audio o video
            if (message.type !== 'text' && message.type !== 'audio' && message.type !== 'video') {
                res.sendStatus(200);
                return;
            }

            let from = message.from; // Número del remitente (ej: 54911...)
            // FIX ARGENTINA: Meta rechaza el '9' y exige el '15' para cuentas de prueba
            if (from.startsWith('54911')) {
                from = from.replace('54911', '541115');
            }

            let text = '';
            if (message.type === 'text') {
                text = message.text.body.trim();
            } else if (message.type === 'audio') {
                text = '[🎤 Audio recibido]';
            } else if (message.type === 'video') {
                text = '[📹 Video recibido]';
            }
            
            const textLower = text.toLowerCase();

            console.log(`Mensaje recibido de ${from}: ${text}`);

            let profNumber = MOCK_PROFESSIONAL_NUMBER;
            if (profNumber && profNumber.startsWith('54911')) {
                profNumber = profNumber.replace('54911', '541115');
            }

            // --- FLUJO DEL PROFESIONAL (Simulado) ---
            if (profNumber && from === profNumber && textLower.startsWith('aceptar')) {
                const jobId = text.split(' ')[1]; // Ej: ACEPTAR 54911...
                if (jobId && pendingJobs[jobId]) {
                    const job = pendingJobs[jobId];
                    await sendMessage(from, `✅ Has aceptado el trabajo de ${job.category} para el cliente ${job.name}.\n\nComunícate con el cliente al wa.me/${jobId}`);
                    
                    // Avisar al cliente
                    await sendMessage(jobId, `¡Buenas noticias! 🎉 Un profesional ha aceptado tu solicitud.\nSe pondrá en contacto contigo a la brevedad.`);
                    
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
                await sendMessage(from, `¡Hola! Soy tu asistente de reparaciones. 🛠️\n\nPara empezar, ¿cuál es tu nombre?`);
                res.sendStatus(200);
                return;
            }

            const session = userSessions[from];

            // Reiniciar flujo
            if (textLower === 'cancelar' || textLower === 'hola' || textLower === 'menu' || textLower === 'salir') {
                session.step = 0;
                await sendMessage(from, `¡Hola! Soy tu asistente de reparaciones. 🛠️\n\nPara empezar, ¿cuál es tu nombre?`);
                res.sendStatus(200);
                return;
            }

            // Máquina de estados
            switch (session.step) {
                case 0: // Recibe el nombre
                    session.name = text;
                    session.step = 1;
                    await sendMessage(from, `¡Un gusto, ${session.name}! 👋\n\n¿Qué servicio necesitas hoy? Responde con el *número* de la opción:\n\n1️⃣ Plomero\n2️⃣ Gasista\n3️⃣ Electricista\n4️⃣ Albañil\n5️⃣ Pintor\n6️⃣ Cerrajero\n7️⃣ Limpieza`);
                    break;

                case 1: // Recibe el servicio
                    const categorias = {
                        '1': 'Plomería', '2': 'Gas', '3': 'Electricidad',
                        '4': 'Albañilería', '5': 'Pintura', '6': 'Cerrajería', '7': 'Limpieza'
                    };
                    const seleccion = categorias[text as keyof typeof categorias];
                    
                    if (seleccion) {
                        session.category = seleccion;
                        session.step = 2;
                        await sendMessage(from, `Excelente, necesitas un experto en *${seleccion}*.\n\n¿Qué nivel de urgencia tiene el trabajo?\n1️⃣ Urgente (Para hoy mismo)\n2️⃣ Normal (En el transcurso de la semana)`);
                    } else {
                        await sendMessage(from, `❌ Opción no válida. Por favor responde solo con un número del 1 al 7.`);
                    }
                    break;

                case 2: // Recibe urgencia
                    if (text === '1' || text === '2') {
                        session.urgency = text === '1' ? 'Urgente (Hoy)' : 'Normal (Semana)';
                        session.step = 3;
                        await sendMessage(from, `Entendido. Urgencia: *${session.urgency}*.\n\nAhora, por favor *describe brevemente el problema* y dinos en qué *zona/barrio* te encuentras.\n\n*(💡 También puedes enviarnos un *audio* o un *video* corto mostrando el problema)*.`);
                    } else {
                        await sendMessage(from, `❌ Opción no válida. Responde con 1 (Urgente) o 2 (Normal).`);
                    }
                    break;

                case 3: // Recibe descripción
                    session.description = text;
                    session.step = 4;
                    const resumen = `📋 *Resumen de tu solicitud:*\n\n👤 *Nombre:* ${session.name}\n🛠️ *Servicio:* ${session.category}\n⏱️ *Urgencia:* ${session.urgency}\n📝 *Detalle:* ${session.description}\n\n¿Deseas enviar esta solicitud a nuestra red de profesionales?\n\n1️⃣ Sí, enviar solicitud\n2️⃣ Cancelar y volver al inicio`;
                    await sendMessage(from, resumen);
                    break;
                    
                case 4: // Confirmación final
                    if (text === '1') {
                        pendingJobs[from] = {
                            name: session.name,
                            category: session.category,
                            urgency: session.urgency,
                            description: session.description
                        };
                        await sendMessage(from, `✅ ¡Solicitud enviada con éxito!\n\nEstamos buscando un profesional disponible. Te notificaremos por este medio apenas uno acepte el trabajo.\n\n*(Escribe 'cancelar' si deseas anularla)*`);
                        
                        // Simular búsqueda enviando mensaje al profesional
                        if (profNumber) {
                            await sendMessage(profNumber, `🚨 *¡NUEVO TRABAJO!* 🚨\n\n👤 *Cliente:* ${session.name}\n🛠️ *Rubro:* ${session.category}\n⏱️ *Urgencia:* ${session.urgency}\n📝 *Detalle y Zona:* ${session.description}\n\nPara aceptar este trabajo, responde exactamente con:\nACEPTAR ${from}`);
                        }
                        session.step = 5; // En espera
                    } else if (text === '2') {
                        session.step = 0;
                        await sendMessage(from, `🚫 Solicitud cancelada.\n\n¿Cuál es tu nombre para comenzar de nuevo?`);
                    } else {
                        await sendMessage(from, `❌ Responde 1 para Enviar o 2 para Cancelar.`);
                    }
                    break;

                case 5: // En espera de profesional
                    await sendMessage(from, `Ya tienes una solicitud de ${session.category} en curso. Estamos esperando que un profesional la acepte.\n\nEscribe "cancelar" si deseas anularla.`);
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
