import { FastifyInstance } from 'fastify';
import { uploadToR2 } from '../../services/r2.service.js';
import { AppError } from '../../utils/errors.js';

export default async function uploadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.post('/file', async (req, reply) => {
    const part = await req.file();
    if (!part) throw new AppError('No file provided', 400, 'FILE_REQUIRED');

    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch (err: any) {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new AppError('File exceeds the 50 MB limit', 413, 'FILE_TOO_LARGE');
      }
      throw err;
    }

    if (buffer.length === 0) throw new AppError('File is empty', 400, 'FILE_EMPTY');

    const result = await uploadToR2(buffer, part.filename, part.mimetype);
    return reply.status(200).send(result);
  });
}
