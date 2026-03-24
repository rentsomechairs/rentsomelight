import { APP_CONFIG } from './config.js';

let firebaseApp;
let auth;
let db;
let storage;
let authReadyPromise;

function hasFirebaseConfig() {
  const cfg = APP_CONFIG.firebase?.config || {};
  return APP_CONFIG.firebase?.enabled && cfg.apiKey && cfg.authDomain && cfg.projectId && cfg.appId;
}

export function isFirebaseEnabled() {
  return Boolean(hasFirebaseConfig());
}

export async function initFirebase() {
  if (!hasFirebaseConfig()) return null;
  if (firebaseApp) return { firebaseApp, auth, db, storage };

  const appMod = await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js');
  const authMod = await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js');
  const fireMod = await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js');
  const storageMod = await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js');

  firebaseApp = appMod.initializeApp(APP_CONFIG.firebase.config);
  auth = authMod.getAuth(firebaseApp);
  db = fireMod.getFirestore(firebaseApp);
  storage = storageMod.getStorage(firebaseApp);

  authReadyPromise = new Promise((resolve) => {
    const unsub = authMod.onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user || null);
    });
  });

  return { firebaseApp, auth, db, storage };
}

export async function waitForAuthReady() {
  if (!isFirebaseEnabled()) return null;
  await initFirebase();
  return authReadyPromise;
}

export async function firebaseLogin(email, password) {
  const { auth } = await initFirebase();
  const authMod = await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js');
  return authMod.signInWithEmailAndPassword(auth, email, password);
}

export async function firebaseLogout() {
  const { auth } = await initFirebase();
  const authMod = await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js');
  return authMod.signOut(auth);
}

export async function getCurrentFirebaseUser() {
  if (!isFirebaseEnabled()) return null;
  await waitForAuthReady();
  return auth.currentUser || null;
}

export async function listCollection(name) {
  const { db } = await initFirebase();
  const fireMod = await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js');
  const snap = await fireMod.getDocs(fireMod.collection(db, name));
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function upsertDoc(collectionName, id, data) {
  const { db } = await initFirebase();
  const fireMod = await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js');
  await fireMod.setDoc(fireMod.doc(db, collectionName, id), data, { merge: false });
}

export async function deleteDocById(collectionName, id) {
  const { db } = await initFirebase();
  const fireMod = await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js');
  await fireMod.deleteDoc(fireMod.doc(db, collectionName, id));
}

export async function uploadFile(path, file) {
  const { storage } = await initFirebase();
  const storageMod = await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js');
  const storageRef = storageMod.ref(storage, path);
  await storageMod.uploadBytes(storageRef, file);
  return storageMod.getDownloadURL(storageRef);
}
