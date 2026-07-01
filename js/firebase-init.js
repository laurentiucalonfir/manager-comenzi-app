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

const FIREBASE_VAPID_KEY = 'BJ-N9dCKkIwneqqey0tBXjExLUt9MHQbkLdQyiJ_LtnSocjMnjIPso94zFsrz6TOINGgZFRbnI3I_PYRTMx9Ts8';

function initFirebase() {
  if (typeof firebase === 'undefined') return;
  if (FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') return;
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    firebase.database();

    let isLocalAdmin = false;
    try {
      const s = localStorage.getItem('sess_user') || sessionStorage.getItem('sess_user');
      if (s) {
        const u = JSON.parse(s);
        if (u && u.isAdmin) isLocalAdmin = true;
      }
    } catch(e) {}

    firebase.auth().onAuthStateChanged(function(user) {
      if (user) {
        authUser = user;
        authReady = true;
        console.log('Auth user:', user.uid);
      } else {
        if (!isLocalAdmin) {
          firebase.auth().signInAnonymously().catch(function(err) {
            console.warn('Auth anonimă nereușită:', err);
          });
        } else {
          authUser = null;
          authReady = true;
        }
      }
    });

    firebaseReady = true;
    console.log('Firebase conectat');
  } catch (e) {
    console.warn('Firebase init error:', e);
  }
}

initFirebase();
