async function test() {
  const tunnelUrl = 'https://creation-houses-fonts-regard.trycloudflare.com';
  console.log('Testing conversion on tunnel:', tunnelUrl);

  const res = await fetch(`${tunnelUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      format: '360p'
    })
  });

  const data = await res.json();
  console.log('Convert response:', data);

  if (!data.jobId) return;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const statusRes = await fetch(`${tunnelUrl}/api/status/${data.jobId}`);
    const statusData = await statusRes.json();
    console.log(`[Poll ${i+1}] Status:`, statusData.status, 'Progress:', statusData.progress, 'Message:', statusData.message);
    if (statusData.status === 'completed') {
      console.log('✓ CONVERSION COMPLETED SUCCESSFULLY VIA RESIDENTIAL TUNNEL!');
      console.log('Download URL:', `${tunnelUrl}${statusData.downloadUrl}`);
      break;
    }
    if (statusData.status === 'failed') {
      console.error('✗ Conversion failed:', statusData.error);
      break;
    }
  }
}

test().catch(console.error);
