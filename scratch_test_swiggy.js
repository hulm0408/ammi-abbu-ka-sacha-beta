(async () => {
  const url = 'https://www.swiggy.com/ofo/address/Umbashiya/amqq8oRnM';
  const res = await fetch(url);
  const html = await res.text();
  const scriptRegex = /src="([^"]+\.js)"/g;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    const scriptPath = match[1];
    const scriptUrl = scriptPath.startsWith('http') ? scriptPath : 'https://www.swiggy.com' + scriptPath;
    try {
      const sRes = await fetch(scriptUrl);
      const sText = await sRes.text();
      if (sText.includes('ofo') || sText.includes('orderForOthers') || sText.includes('share-address')) {
        console.log('Match found in:', scriptUrl);
        const apis = sText.match(/\/dapi\/[a-zA-Z0-9_\-\/]+/g) || [];
        const filtered = Array.from(new Set(apis)).filter(a => a.includes('ofo') || a.includes('address') || a.includes('cart'));
        console.log('APIs:', filtered);
      }
    } catch (e) {}
  }
})();
