function delimiter(text:string):string {
 const counts:Record<string,number>={',':0,';':0,'\t':0};let quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"')i++;else quoted=!quoted;}
  else if(!quoted){if(c==='\n'||c==='\r')break;if(Object.hasOwn(counts,c))counts[c]++;}
 }
 return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
}
/** Bounded RFC-style parsing with common spreadsheet separators and BOM support. */
export function parseCSV(source:string):string[][] {
 if(source.length>2_000_000)throw Error('CSV должен быть меньше 2 МБ.');
 const text=source.replace(/^\uFEFF/,''),separator=delimiter(text),rows:string[][]=[];
 let row:string[]=[],value='',quoted=false,closed=false,cells=0;
 const cell=()=>{if(row.length>=256||++cells>250000)throw Error('Слишком большая таблица: до 256 столбцов и 250 000 ячеек.');row.push(value);value='';closed=false;};
 const endRow=()=>{cell();if(rows.length>=50000)throw Error('CSV должен содержать до 50 000 строк.');rows.push(row);row=[];};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else value+=c;continue;}
  if(c===separator){cell();continue;}
  if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;endRow();continue;}
  if(c==='"'){if(value!==''||closed)throw Error('Кавычка внутри незаключённой в кавычки ячейки CSV.');quoted=true;continue;}
  if(closed)throw Error('После закрывающей кавычки нужен разделитель или конец строки.');value+=c;
 }
 if(quoted)throw Error('Незакрытая кавычка CSV.');if(row.length||value||closed)endRow();return rows;
}
export function analyzeCSV(text:string){
 const rows=parseCSV(text),header=rows.shift()??[];
 return {rows:rows.length,columns:header.map((name,i)=>{
  const values=rows.map(r=>r[i]??''),numbers=values.filter(v=>v.trim()!==''&&Number.isFinite(Number(v))).map(Number);
  return {name,filled:values.filter(v=>v.trim()!=='').length,numeric:numbers.length,min:numbers.length?numbers.reduce((a,b)=>Math.min(a,b),Infinity):null,max:numbers.length?numbers.reduce((a,b)=>Math.max(a,b),-Infinity):null,mean:numbers.length?numbers.reduce((a,b)=>a+b/numbers.length,0):null};
 }),raggedRows:rows.filter(r=>r.length!==header.length).length};
}
