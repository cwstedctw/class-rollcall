// 本機頁面的 google.script.run 透過 HTTP 呼叫同一份 Apps Script 後端。
(function () {
  const params = new URLSearchParams(window.location.search);
  const user = params.get('user');

  function runner(success, failure) {
    return new Proxy({}, {
      get(_target, name) {
        if (name === 'withSuccessHandler') return (handler) => runner(handler, failure);
        if (name === 'withFailureHandler') return (handler) => runner(success, handler);
        return async function (...args) {
          const input = { fn: name, args };
          if (user !== null) input.user = user;
          let result;
          try {
            const response = await fetch('/rpc', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(input),
            });
            const payload = await response.json();
            if (!response.ok || !payload.ok) throw new Error(payload.error || '本機預覽暫時無法連線');
            result = payload.result;
          } catch (error) {
            if (failure) failure(error);
            else console.error(error);
            return;
          }
          if (success) success(result);
        };
      },
    });
  }

  window.google = {
    script: {
      run: runner(null, null),
      url: {
        getLocation(callback) {
          callback({ parameter: Object.fromEntries(params), hash: window.location.hash.slice(1) });
        },
      },
    },
  };
})();
