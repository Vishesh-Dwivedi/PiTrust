const url = 'https://trustpi.space/api/passport/approve-mint';

fetch(url, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer fake_token'
    },
    body: JSON.stringify({ paymentId: '1234567890123' })
})
    .then(res => res.text().then(text => ({ status: res.status, text })))
    .then(console.log)
    .catch(console.error);
