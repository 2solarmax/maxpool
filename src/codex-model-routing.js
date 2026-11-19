const families = {
  fable: 'astra',
  opus: 'astra',
  sonnet: 'sol',
  haiku: 'luna',
};
const stableSlug = /^gpt-\d+(?:\.\d+)*-(astra|sol|luna)$/i;

export function validCodexCatalog(models) {
  return Array.isArray(models) && models.length > 0 && models.length <= 128
    && models.every(model => typeof model?.slug === 'string' && /^[a-z0-9][a-z0-9._-]{0,100}$/i.test(model.slug)
      && (model.efforts == null || (Array.isArray(model.efforts) && model.efforts.length <= 12
        && model.efforts.every(effort => typeof effort === 'string' && effort.length <= 20))));
}

export function codexModelFor(request, account) {
  const { openAIModel, model, reasoningEffort } = request;
  const models = account.quota?.codexModels ?? account.codexModels;
  if (account.codexAuth !== 'native' && !models) {
    return openAIModel || account.model || 'gpt-6.2-sol';
  }
  if (!Array.isArray(models)) return null;
  const requestedClass = /\b(fable|opus|sonnet|haiku)\b/i.exec(model || '')?.[1]?.toLowerCase() || 'sonnet';
  const candidates = models
    .filter(candidate => (openAIModel
      ? candidate.slug === openAIModel
      : stableSlug.exec(candidate.slug)?.[1]?.toLowerCase() === families[requestedClass])
      && (!reasoningEffort || !candidate.efforts?.length || candidate.efforts.includes(reasoningEffort))
      && (!request.hasImage || candidate.supportsVision !== false)
      && (!request.hasTools || candidate.supportsTools !== false)
      && (!candidate.contextWindow || !request.inputTokens || request.inputTokens <= candidate.contextWindow))
    .sort((a, b) => b.slug.localeCompare(a.slug, 'en', { numeric: true }));
  return candidates.find(candidate => candidate.slug === account.model)?.slug ?? candidates[0]?.slug ?? null;
}
