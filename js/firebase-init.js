const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyA1gDoHZVARzLSR7EjOdMj2BVXkXD_LkS0',
  authDomain: 'comenzi-corina-caffe.firebaseapp.com',
  databaseURL: 'https://comenzi-corina-caffe-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'comenzi-corina-caffe',
  storageBucket: 'comenzi-corina-caffe.firebasestorage.app',
  messagingSenderId: '820994532115',
  appId: '1:820994532115:web:f5a13771b57ec0a27530e6'
};

let firebaseReady = false;
let authReady = false;
let authUser = null;

// VAPID key for FCM web push
const FIREBASE_VAPID_KEY = 'BJ-N9dCKkIwneqqey0tBXjExLUt9MHQbkLdQyiJ_LtnSocjMnjIPso94zFsrz6TOINGgZFRbnI3I_PYRTMx9Ts8';

function initFirebase() {
  if (typeof firebase === 'undefined') return;
  if (FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') return;
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    firebase.database();

    firebase.auth().signInAnonymously().catch(function(err) {
      console.warn('Auth anonimă nereușită:', err);
    });
    firebase.auth().onAuthStateChanged(function(user) {
      authUser = user;
      authReady = true;
      if (user) {
        console.log('Auth user:', user.uid);
      }
    });

    firebaseReady = true;
    console.log('Firebase conectat');
  } catch (e) {
    console.warn('Firebase init error:', e);
  }
}

initFirebase();
