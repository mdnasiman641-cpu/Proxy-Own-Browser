/** A requested record (profile, group, tag, template) does not exist. Shown to the user as-is. */
export class NotFoundError extends Error {
  constructor(message = 'Profile not found') {
    super(message)
    this.name = 'NotFoundError'
  }
}
