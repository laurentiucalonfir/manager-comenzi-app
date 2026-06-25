const { onValueWritten } = require('firebase-functions/v2/database');
const admin = require('firebase-admin');
admin.initializeApp();

exports.sendOrderNotification = onValueWritten(
  { ref: '/orders/{orderId}', region: 'europe-west1' },
  async (event) => {
    const order = event.data.after.val();
    console.log('Function triggered, order:', order ? order.location + '/' + order.supplier : 'null');
    if (!order || !order.location) { console.log('No order or location'); return; }

    // Skip old orders (from bulk sync) — only notify orders newer than 60s
    if (order.timestamp && Date.now() - order.timestamp > 60000) { console.log('Old order, skip'); return; }

    const debounceKey = 'debounce_' + order.location;
    const now = Date.now();
    const debounced = await admin.database().ref('_fcm/' + debounceKey).transaction(function(current) {
      if (current && now - current < 60000) { return; }
      return now;
    });
    if (!debounced.committed) { console.log('Debounced for', order.location); return; }

    const tokensSnap = await admin.database().ref('fcmTokens').once('value');
    const tokensMap = tokensSnap.val();
    console.log('FCM tokens map:', tokensMap ? Object.keys(tokensMap).length : 'null');
    if (!tokensMap) return;

    const tokens = Object.keys(tokensMap).filter(t => typeof t === 'string' && t.length > 20);
    console.log('Valid tokens:', tokens.length);
    if (!tokens.length) return;

    const result = await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: {
        title: 'Comanda noua',
        body: order.location + ' a trimis o comanda!'
      },
      webpush: {
        notification: { icon: '/icon-192.png' }
      }
    });
    console.log('FCM sent to', tokens.length, 'tokens, success:', result.successCount, 'fail:', result.failureCount);

    if (result.failureCount > 0) {
      const cleanups = [];
      result.responses.forEach((resp, i) => {
        if (resp.error) {
          console.log('FCM error for token', i, ':', resp.error.code, resp.error.message);
          if (resp.error.code === 'messaging/invalid-registration-token' || resp.error.code === 'messaging/registration-token-not-registered') {
            cleanups.push(admin.database().ref('fcmTokens/' + tokens[i]).remove());
          }
        }
      });
      await Promise.all(cleanups);
    }
  }
);
