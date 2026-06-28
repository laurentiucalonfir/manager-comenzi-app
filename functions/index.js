const { onValueWritten } = require('firebase-functions/v2/database');
const admin = require('firebase-admin');
admin.initializeApp();

function sanitizeKey(s) {
  return (s || '').replace(/[.#$\[\]]/g, '·');
}

exports.sendOrderNotification = onValueWritten(
  { ref: '/orders/{orderId}', region: 'europe-west1' },
  async (event) => {
    const order = event.data.after.val();
    if (!order || !order.location) return;

    const safeLoc = sanitizeKey(order.location);
    const debounceKey = 'debounce_' + safeLoc;

    const last = await admin.database().ref('_fcm/' + debounceKey).once('value');
    const now = Date.now();
    if (last.val() && now - last.val() < 10000) return;
    await admin.database().ref('_fcm/' + debounceKey).set(now);

    const tokensSnap = await admin.database().ref('fcmTokens').once('value');
    const tokensMap = tokensSnap.val();
    if (!tokensMap) return;

    const tokenMap = new Map();
    Object.entries(tokensMap)
      .filter(([k, v]) => typeof v === 'string' && v.length > 20 && !k.startsWith('_'))
      .forEach(([k, v]) => { if (!tokenMap.has(v)) tokenMap.set(v, k); });
    const tokens = [...tokenMap.keys()];
    if (!tokens.length) return;

    const payload = {
      data: {
        title: 'Comanda noua',
        body: order.location + ' a trimis o comanda!',
        icon: '/icon-192.png',
        clickUrl: '/'
      }
    };

    const result = await admin.messaging().sendEachForMulticast({ tokens, ...payload });
    console.log('FCM sent to', tokens.length, 'tokens, success:', result.successCount, 'fail:', result.failureCount);

    if (result.failureCount > 0) {
      result.responses.forEach((resp, i) => {
        if (resp.error && (resp.error.code === 'messaging/invalid-registration-token' || resp.error.code === 'messaging/registration-token-not-registered')) {
          admin.database().ref('fcmTokens/' + tokenMap.get(tokens[i])).remove();
        }
      });
    }
  }
);
