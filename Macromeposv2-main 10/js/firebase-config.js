/* Macrome cloud settings.
   Leave apiKey empty and Macrome runs exactly as before: one device, accounts and data stored on that device.
   To switch on the shared cloud mode, paste your Firebase web-app config below (Firebase console ->
   Project settings -> Your apps -> Web app -> "Config"). See firebase/SETUP.md for the full steps.
   These values are not secrets: the security rules (firebase/firestore.rules) are what protect the data. */
window.MACROME_CLOUD = {
  firebase: {
    apiKey: 'AIzaSyBa9EFZGx3_0rcsaQ3_CrWNqiCBTfRaTnA',
    authDomain: 'macrome-test.firebaseapp.com',
    projectId: 'macrome-test',
    storageBucket: 'macrome-test.firebasestorage.app',
    messagingSenderId: '24269837857',
    appId: '1:24269837857:web:9962b4880dcd1faa3ff560'
  },
  // Staff type a username; behind the scenes it becomes  username@emailDomain  (never used to send mail).
  emailDomain: 'macrome.app'
};
