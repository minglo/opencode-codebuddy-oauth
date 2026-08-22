// src/log.ts
export interface Logger { debug(m:string, extra?:object):void; info(m:string, extra?:object):void; warn(m:string, extra?:object):void; error(m:string, extra?:object):void; }
export function createLogger(client?: any): Logger {
  const sink = (level:string, message:string, extra?:object) => {
    if (client?.app?.log) client.app.log({ body: { service: "codebuddy", level, message, extra } }).catch(()=>{});
    else if (level==="warn"||level==="error") console.error(`[codebuddy] ${level}: ${message}`, extra ?? "");
  };
  return { debug:(m,e)=>sink("debug",m,e), info:(m,e)=>sink("info",m,e), warn:(m,e)=>sink("warn",m,e), error:(m,e)=>sink("error",m,e) };
}