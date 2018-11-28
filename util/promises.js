module.exports = class PromiseHelper {

    static serial(funcs) {
        return funcs.reduce((promise, func) =>
            promise.then(result =>
                func().then(res => {
                    result.push(res);
                    return result;
                })
            ), Promise.resolve([])
        );
    }

    static while(condition, action) {
        return new Promise((resolve, reject) => {

            const loop = () => {

                if (!condition()) {
                    return resolve();
                }

                let promise;
                try {
                    promise = action();

                    if (!promise || typeof promise !== 'object' || !('then' in promise)) {
                        promise = Promise.resolve(promise);
                    }
                }
                catch (ex) {
                    promise = Promise.reject(ex);
                }

                return promise.then(loop).catch(reject);
            };

            if (setImmediate) {
                setImmediate(loop);
            }
            else {
                process.nextTick(loop);
            }

        });
    }

    /**
     * @returns {{promise: Promise<*>, resolve: function(result: *?), reject: function(error: *)}}
     */
    static pending() {
        let resolve = null, reject = null,
            promise = new Promise((r, j) => {
                resolve = r;
                reject = j;
            });

        return {
            promise: promise,
            resolve: resolve,
            reject: reject,
        };
    }
};