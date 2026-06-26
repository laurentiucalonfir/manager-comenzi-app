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
    if (!tokensMap) { console.log('No tokens map'); return; }

    // Build deduplicated token list; support both old {token: true} and new {deviceId: token} formats
    const tokenToKey = {};
    Object.keys(tokensMap).forEach(function(key) {
      var val = tokensMap[key];
      if (typeof val === 'string' && val.length > 20) {
        tokenToKey[val] = key; // new format: key=deviceId, val=token
      } else if (val === true && typeof key === 'string' && key.length > 20) {
        tokenToKey[key] = key; // old format: key=token, val=true
      }
    });
    const tokens = Object.keys(tokenToKey);
    console.log('Tokens deduplicated:', tokens.length, 'unique, from', Object.keys(tokensMap).length, 'entries');
    if (!tokens.length) return;

    const result = await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: {
        title: 'Comanda noua',
        body: order.location + ' a trimis o comanda!',
        icon: '/icon-192.png'
      },
      data: {
        title: 'Comanda noua',
        body: order.location + ' a trimis o comanda!',
        click_url: '/'
      }
    });
    console.log('FCM sent to', tokens.length, 'tokens, success:', result.successCount, 'fail:', result.failureCount);

    if (result.failureCount > 0) {
      const cleanups = [];
      result.responses.forEach(function(resp, i) {
        if (resp.error) {
          console.log('FCM error for token', i, ':', resp.error.code, resp.error.message);
          if (resp.error.code === 'messaging/invalid-registration-token' || resp.error.code === 'messaging/registration-token-not-registered') {
            cleanups.push(admin.database().ref('fcmTokens/' + tokenToKey[tokens[i]]).remove());
          }
        }
      });
      await Promise.all(cleanups);
    }
  }
);
