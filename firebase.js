// Configuración del proyecto "sellos-barberia" (Firebase Console > Configuración del proyecto)
// Nota: usamos los módulos desde la CDN de Firebase porque este proyecto no usa npm.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDuj3v4u4Ts7W_RxL9SAgIObAQeoAP3w6s',
  authDomain: 'sellos-barberia.firebaseapp.com',
  projectId: 'sellos-barberia',
  storageBucket: 'sellos-barberia.firebasestorage.app',
  messagingSenderId: '205182409487',
  appId: '1:205182409487:web:3149ed14ede7eb7e71fc7a'
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);