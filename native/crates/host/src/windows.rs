//! User-scoped, local-only IPC for trusted built-in operations.
//! This is NOT an AppContainer boundary. Windows integration acceptance is pending.
use super::*;
use std::{ffi::c_void, mem::{size_of,zeroed}, os::windows::io::{OwnedHandle,FromRawHandle,AsRawHandle}, ptr::{null,null_mut}, time::{Duration,Instant}};
use windows_sys::Win32::{
 Foundation::*,
 Security::{GetTokenInformation,TokenUser,TOKEN_QUERY,TOKEN_USER,SECURITY_ATTRIBUTES,Authorization::{ConvertSidToStringSidW,ConvertStringSecurityDescriptorToSecurityDescriptorW}},
 Storage::FileSystem::*,
 System::{IO::{OVERLAPPED,GetOverlappedResult,CancelIoEx},Pipes::*,Threading::*},
};
// LocalFree's allocation contract is fixed by the Win32 API. No Rust allocator owns these pointers.
#[link(name="kernel32")]
unsafe extern "system" { fn LocalFree(hmem:*mut c_void)->*mut c_void; }
fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
fn os_error()->Error{std::io::Error::last_os_error().into()}
fn own(h:HANDLE)->Result<OwnedHandle>{if h.is_null()||h==INVALID_HANDLE_VALUE {Err(os_error())}else{Ok(unsafe{OwnedHandle::from_raw_handle(h)})}}
struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {fn drop(&mut self){if !self.0.is_null(){unsafe{LocalFree(self.0);}}}}
pub fn current_sid()->Result<String>{unsafe{
 let mut token=null_mut();if OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&mut token)==0{return Err(os_error());}let token=own(token)?;
 let mut needed=0;GetTokenInformation(token.as_raw_handle(),TokenUser,null_mut(),0,&mut needed);
 ensure(needed>0&&needed<65536,"TOKEN","Неверный размер токена")?;
 let mut data=vec![0u8;needed as usize];if GetTokenInformation(token.as_raw_handle(),TokenUser,data.as_mut_ptr().cast(),needed,&mut needed)==0{return Err(os_error());}
 let user=std::ptr::read_unaligned(data.as_ptr().cast::<TOKEN_USER>());let mut text=null_mut();
 if ConvertSidToStringSidW(user.User.Sid,&mut text)==0{return Err(os_error());}let _allocation=LocalAllocation(text.cast());
 let mut len=0usize;while len<512&&*text.add(len)!=0{len+=1;}ensure(len<512,"TOKEN","SID слишком длинный")?;
 Ok(String::from_utf16_lossy(std::slice::from_raw_parts(text,len)))
}}
fn pipe_name()->Result<String>{Ok(format!(r"\\.\pipe\PlatformStudio-v1-{}",current_sid()?))}
fn descriptor(sid:&str)->Result<LocalAllocation>{unsafe{
 let text=wide(&format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid})"));let mut sd=null_mut();
 if ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(),1,&mut sd,null_mut())==0{return Err(os_error());}Ok(LocalAllocation(sd))
}}
fn attrs(sd:&LocalAllocation)->SECURITY_ATTRIBUTES{SECURITY_ATTRIBUTES{nLength:size_of::<SECURITY_ATTRIBUTES>()as u32,lpSecurityDescriptor:sd.0,bInheritHandle:0}}
fn wait_io(handle:HANDLE,ov:&mut OVERLAPPED,timeout:u32)->Result<u32>{unsafe{
 let wait=WaitForSingleObject(ov.hEvent,timeout);let mut transferred=0;
 if wait!=WAIT_OBJECT_0 {
  CancelIoEx(handle,ov);
  // OVERLAPPED and data buffers must stay alive until cancellation has completed.
  GetOverlappedResult(handle,ov,&mut transferred,1);
  return Err(Error::new("IPC_TIMEOUT","IPC не завершён; исход команды надо сверить, а не повторять"));
 }
 if GetOverlappedResult(handle,ov,&mut transferred,0)==0{return Err(os_error());}Ok(transferred)
}}
struct Pipe {handle:OwnedHandle,deadline:Instant}
impl Pipe {
 fn remaining(&self)->Result<u32>{let d=self.deadline.saturating_duration_since(Instant::now());ensure(!d.is_zero(),"IPC_TIMEOUT","Истекло время IPC")?;Ok(d.as_millis().min(u32::MAX as u128-1)as u32)}
 fn transfer(&self,buffer:&mut [u8],writing:bool)->Result<usize>{unsafe{
  let timeout=self.remaining()?;let event=own(CreateEventW(null(),1,0,null()))?;let mut ov:OVERLAPPED=zeroed();ov.hEvent=event.as_raw_handle();let mut count=0;
  let ok=if writing{WriteFile(self.handle.as_raw_handle(),buffer.as_ptr(),buffer.len()as u32,&mut count,&mut ov)}else{ReadFile(self.handle.as_raw_handle(),buffer.as_mut_ptr(),buffer.len()as u32,&mut count,&mut ov)};
  if ok!=0{return Ok(count as usize);}if GetLastError()!=ERROR_IO_PENDING{return Err(os_error());}
  Ok(wait_io(self.handle.as_raw_handle(),&mut ov,timeout)?as usize)
 }}
 fn read_exact(&self,data:&mut[u8])->Result<()>{let mut offset=0;while offset<data.len(){let count=self.transfer(&mut data[offset..],false)?;ensure(count>0,"IPC_EOF","Соединение прервалось")?;offset+=count;}Ok(())}
 fn write_all(&self,data:&[u8])->Result<()>{let mut copy=data.to_vec();let mut offset=0;while offset<copy.len(){let count=self.transfer(&mut copy[offset..],true)?;ensure(count>0,"IPC_EOF","Соединение прервалось")?;offset+=count;}Ok(())}
 fn read(&self)->Result<Vec<u8>>{let mut size=[0u8;4];self.read_exact(&mut size)?;let n=u32::from_le_bytes(size)as usize;ensure(n>0&&n<=MAX_FRAME,"FRAME","Неверный размер кадра")?;let mut bytes=vec![0;n];self.read_exact(&mut bytes)?;Ok(bytes)}
 fn write(&self,bytes:&[u8])->Result<()>{ensure(!bytes.is_empty()&&bytes.len()<=MAX_FRAME,"FRAME","Неверный размер кадра")?;self.write_all(&(bytes.len()as u32).to_le_bytes())?;self.write_all(bytes)}
}
pub fn request(method:&str,params:Value)->Result<Value>{unsafe{
 let name=wide(&pipe_name()?);let h=CreateFileW(name.as_ptr(),FILE_GENERIC_READ|FILE_GENERIC_WRITE,0,null(),OPEN_EXISTING,FILE_FLAG_OVERLAPPED|SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION,null_mut());
 let pipe=Pipe{handle:own(h)?,deadline:Instant::now()+Duration::from_secs(30)};
 let id=new_id("ipc");pipe.write(&serde_json::to_vec(&Request{id:id.clone(),method:method.into(),params})?)?;
 let response:Value=serde_json::from_slice(&pipe.read()?)?;pipe.write_all(&[1])?;ensure(response["id"].as_str()==Some(id.as_str()),"IPC_ID","Ответ другой команды")?;
 if !response["error"].is_null(){let e=&response["error"];return Err(Error::new(e["code"].as_str().unwrap_or("HOST"),e["message"].as_str().unwrap_or("Ошибка хоста")));}
 Ok(response["result"].clone())
}}
pub fn serve(root:&Path)->Result<()>{unsafe{
 let sid=current_sid()?;let sd=descriptor(&sid)?;let security=attrs(&sd);
 let mutex_name=wide(&format!(r"Local\PlatformStudio-host-{sid}"));let mutex=CreateMutexW(&security,0,mutex_name.as_ptr());let previous=GetLastError();let _mutex=own(mutex)?;
 ensure(previous!=ERROR_ALREADY_EXISTS,"HOST_EXISTS","Хост уже запущен")?;
 let service=Arc::new(Service::new(root)?);let name=wide(&pipe_name()?);let mut first=true;
 let active=Arc::new(std::sync::atomic::AtomicUsize::new(0));
 loop {
  if active.load(Ordering::SeqCst)>=7 {std::thread::sleep(Duration::from_millis(20));continue;}
  let flags=PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|if first{FILE_FLAG_FIRST_PIPE_INSTANCE}else{0};
  let handle=own(CreateNamedPipeW(name.as_ptr(),flags,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,8,65536,65536,1000,&security))?;first=false;
  let event=own(CreateEventW(null(),1,0,null()))?;let mut ov:OVERLAPPED=zeroed();ov.hEvent=event.as_raw_handle();
  if ConnectNamedPipe(handle.as_raw_handle(),&mut ov)==0 {let code=GetLastError();if code==ERROR_IO_PENDING{wait_io(handle.as_raw_handle(),&mut ov,INFINITE)?;}else if code!=ERROR_PIPE_CONNECTED{return Err(os_error());}}
  active.fetch_add(1,Ordering::SeqCst);let service=service.clone();let active=active.clone();
  std::thread::spawn(move||{
   struct Slot(Arc<std::sync::atomic::AtomicUsize>);impl Drop for Slot{fn drop(&mut self){self.0.fetch_sub(1,Ordering::SeqCst);}}
   let _slot=Slot(active);let pipe=Pipe{handle,deadline:Instant::now()+Duration::from_secs(30)};
   let _= (||->Result<()>{let bytes=pipe.read()?;let req:Request=serde_json::from_slice(&bytes)?;ensure(req.id.len()<=128&&req.method.len()<=64,"REQUEST","Неверный запрос")?;let answer=service.handle(req);pipe.write(&serde_json::to_vec(&answer)?)?;let mut ack=[0u8;1];pipe.read_exact(&mut ack)?;ensure(ack==[1],"IPC_ACK","Неверное подтверждение чтения")?;Ok(())})();
   // Do not FlushFileBuffers: a peer that stops reading must not hold this slot forever.
   // The client ACK above confirms that it read the complete framed response. No effect is retried if this receipt is lost.
  });
 }
}}
