fetch('document', {cache:'no-store'}).then(response => {
  if (!response.ok) throw new Error('请先初始化项目并保存工作流版本。');
  return response.json();
}).then(data => {
  document.getElementById('status').textContent = `版本：${data.version} · ${data.hash}`;
  document.getElementById('document').textContent = data.document;
  document.getElementById('pricing').textContent = JSON.stringify(data.pricing, null, 2);
  document.getElementById('run').textContent = data.run ? JSON.stringify(data.run, null, 2) : '尚无本地测试记录';
}).catch(error => { document.getElementById('status').textContent = error.message; });
