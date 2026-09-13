import sharp from 'sharp';
export async function compressPhoto(bytes){
 // Autorotate from EXIF; strip metadata. Always encode on the server so all clients use the same quality.
 try{return await sharp(bytes,{limitInputPixels:40000000,failOn:'error'}).rotate().webp({quality:80}).toBuffer();}
 catch{throw Object.assign(new Error('Не удалось прочитать фото. Выберите исправный JPG, PNG или WebP до 40 мегапикселей.'),{status:400});}
}
