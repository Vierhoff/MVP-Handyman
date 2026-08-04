const axios = require('axios');
axios.post('https://mvp-handyman.onrender.com/webhook', {
    object: "whatsapp_business_account",
    entry: [{
        changes: [{
            value: {
                metadata: { phone_number_id: "1285594271302775" },
                messages: [{
                    from: "5491127922596",
                    type: "text",
                    text: { body: "Hola" }
                }]
            }
        }]
    }]
}).then(() => console.log('Simulado OK')).catch(e => console.error(e.message));
