const { onValueCreated } = require('firebase-functions/v2/database');
const admin = require('firebase-admin');
admin.initializeApp();

exports.sendOrderNotification = onValueCreated(
  { ref: '/orders/{orderId}', region: 'europe-west1' },
  async (event) => {
    const order = event.data.val();
    if (!order || !order.location) return;

    const debounceKey = 'debounce_' + order.location;
    const last = await admin.database().ref('_fcm/' + debounceKey).once('value');
    const now = Date.now();
    if (last.val() && now - last.val() < 10000) return;
    await admin.database().ref('_fcm/' + debounceKey).set(now);

    const tokensSnap = await admin.database().ref('fcmTokens').once('value');
    const tokensMap = tokensSnap.val();
    if (!tokensMap) return;

    const tokens = Object.keys(tokensMap).filter(t => typeof t === 'string' && t.length > 20);
    if (!tokens.length) return;

    const payload = {
      notification: {
        title: 'Comanda noua',
        body: order.location + ' a trimis o comanda!',
        icon: '/icon-192.png'
      }
    };

    const result = await admin.messaging().sendEachForMulticast({ tokens, ...payload });
    console.log('FCM sent to', tokens.length, 'tokens, success:', result.successCount, 'fail:', result.failureCount);

    if (result.failureCount > 0) {
      result.responses.forEach((resp, i) => {
        if (resp.error && (resp.error.code === 'messaging/invalid-registration-token' || resp.error.code === 'messaging/registration-token-not-registered')) {
          admin.database().ref('fcmTokens/' + tokens[i]).remove();
        }
      });
    }
  }
);
