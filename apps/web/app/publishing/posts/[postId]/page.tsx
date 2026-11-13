import { PostDetail } from "../../../../features/publishing/post";
export default async function PostPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}): Promise<React.JSX.Element> {
  const { postId } = await params;
  return <PostDetail postId={postId} />;
}
