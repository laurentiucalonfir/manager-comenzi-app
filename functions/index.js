const { onValueWritten } = require('firebase-functions/v2/database');
const admin = require('firebase-admin');
admin.initializeApp();

exports.sendOrderNotification = onValueWritten(
  { ref: '/orders/{orderId}', region: 'europe-west1' },
  async (event) => {
    // Only notify on new entries (not updates)
    if (event.data.before.val()) { return; }
    const order = event.data.after.val();
    console.log('Function triggered, order:', order ? order.location + '/' + order.supplier : 'null');
    if (!order || !order.location) { console.log('No order or location'); return; }

    const debounceKey = 'debounce_' + order.location;
    const last = await admin.database().ref('_fcm/' + debounceKey).once('value');
    const now = Date.now();
    if (last.val() && now - last.val() < 10000) { console.log('Debounced for', order.location); return; }
    await admin.database().ref('_fcm/' + debounceKey).set(now);

    const tokensSnap = await admin.database().ref('fcmTokens').once('value');
    const tokensMap = tokensSnap.val();
    console.log('FCM tokens map:', tokensMap ? Object.keys(tokensMap).length : 'null');
    if (!tokensMap) return;

    const tokens = Object.keys(tokensMap).filter(t => typeof t === 'string' && t.length > 20);
    console.log('Valid tokens:', tokens.length);
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
