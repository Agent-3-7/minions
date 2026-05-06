import { Router } from 'express';
import { getBundledSkillWithContent, listBundledSkills, toSkillMeta } from '../skills/catalog.js';

export const skillsRouter = Router();

skillsRouter.get('/', async (_req, res) => {
  const skills = await listBundledSkills();
  res.json({ skills: skills.map(toSkillMeta) });
});

skillsRouter.get('/:id/content', async (req, res) => {
  const result = await getBundledSkillWithContent(req.params.id);
  if (!result) return res.status(404).json({ error: 'Skill not found' });
  res.json({ skill: toSkillMeta(result.skill), content: result.content });
});
