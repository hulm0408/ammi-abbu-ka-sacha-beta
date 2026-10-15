// Test UPI QR generation
const upiId = 'paytm-swiggy@paytm';
const orderId = '48291';
const amount = 349;
const upiUrl = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent('Swiggy Family Care')}&am=${amount}&cu=INR&tn=${encodeURIComponent(`Swiggy Order #${orderId}`)}`;
const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(upiUrl)}`;

console.log('UPI Intent URL:', upiUrl);
console.log('QR Code Image URL:', qrUrl);
