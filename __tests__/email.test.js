jest.mock('fs');
jest.mock('nodemailer');

const fs = require('fs');
const nodemailer = require('nodemailer');
const { sendMail, sendWelcome, sendForgotPassword, sendLoginInfo } = require('../services/email');

const mockSendMail = jest.fn().mockResolvedValue({});

beforeEach(() => {
  jest.clearAllMocks();
  nodemailer.createTransport.mockReturnValue({ sendMail: mockSendMail });
  process.env.SMTP_USER = 'test@test.com';
});

describe('sendMail', () => {
  it('skips sending when SMTP_USER is not set', async () => {
    delete process.env.SMTP_USER;
    const result = await sendMail({ to: 'a@b.com', subject: 'Test', template: 'welcome.html', vars: {} });
    expect(result.skipped).toBe(true);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('loads template, renders vars, and sends email', async () => {
    fs.readFileSync.mockReturnValue('<h1>Hello {{name}}!</h1>');
    const result = await sendMail({ to: 'a@b.com', subject: 'Test', template: 'test.html', vars: { name: 'World' } });
    expect(result.sent).toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith({
      from: '"Cafe Azzura" <noreply@cafeazzura.com>',
      to: 'a@b.com',
      subject: 'Test',
      html: '<h1>Hello World!</h1>',
    });
  });

  it('replaces all occurrences of each var', async () => {
    fs.readFileSync.mockReturnValue('{{x}} {{x}} {{y}}');
    await sendMail({ to: 'a@b.com', subject: 'T', template: 't.html', vars: { x: 'A', y: 'B' } });
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ html: 'A A B' }));
  });
});

describe('sendWelcome', () => {
  it('sends welcome email with correct subject', async () => {
    fs.readFileSync.mockReturnValue('{{name}} {{adminUrl}} {{email}} {{password}} {{plan}}');
    await sendWelcome({ to: 'a@b.com', name: 'Cafe', adminUrl: 'https://admin.cafe.com', email: 'admin@cafe.com', password: 'pass123', plan: 'Free' });
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('Selamat Datang'),
      html: expect.stringContaining('Cafe'),
    }));
  });
});

describe('sendForgotPassword', () => {
  it('sends reset email', async () => {
    fs.readFileSync.mockReturnValue('{{name}} {{resetUrl}}');
    await sendForgotPassword({ to: 'a@b.com', name: 'User', resetUrl: 'https://reset.com/token' });
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('Reset Password'),
    }));
  });
});

describe('sendLoginInfo', () => {
  it('sends login info email', async () => {
    fs.readFileSync.mockReturnValue('{{name}} {{cafeName}} {{adminUrl}} {{email}} {{role}}');
    await sendLoginInfo({ to: 'a@b.com', name: 'Budi', cafeName: 'Cafe A', adminUrl: 'https://admin.com', email: 'a@b.com', role: 'Admin' });
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('Informasi Login'),
    }));
  });
});
