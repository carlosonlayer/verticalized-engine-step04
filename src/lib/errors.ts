/**
 * Erro "esperado" da aplicação: tem código estável, status HTTP e uma mensagem
 * em linguagem de gente (é ela que o frontend mostra).
 *
 * Formato de resposta de erro — igual em toda a API:
 *   { "code": "PDF_PASSWORD", "message": "...", "file"?: "extrato.pdf" }
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly file?: string,
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.file ? { file: this.file } : {}) };
  }
}

export const Errors = {
  notFound: () => new AppError("NOT_FOUND", "Não encontramos o que você procurou.", 404),
  unauthorized: () => new AppError("UNAUTHORIZED", "Você precisa entrar na sua conta.", 401),
  forbidden: () => new AppError("FORBIDDEN", "Você não tem acesso a este trabalho.", 403),
  internal: () =>
    new AppError("INTERNAL", "Algo deu errado do nosso lado. Nada foi perdido; tente de novo em instantes.", 500),
};
