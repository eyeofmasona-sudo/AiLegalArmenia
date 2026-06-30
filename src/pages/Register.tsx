import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { useToast } from '@/hooks/use-toast';
import { UserPlus, Loader2, ArrowLeft } from 'lucide-react';

const registerSchema = z.object({
  email: z.string().email('Պիտի լինի վավեր էլ. հասցե'),
  password: z.string().min(6, 'Գաղտնաբառը պետք է ունենա առնվազն 6 նիշ'),
  fullName: z.string().min(2, 'Անունը պիտի լինի առնվազն 2 նիշ').max(100),
});

type RegisterValues = z.infer<typeof registerSchema>;

const Register = () => {
  const navigate = useNavigate();
  const { signUp } = useAuth();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: '', password: '', fullName: '' },
  });

  const handleRegister = async (values: RegisterValues) => {
    setIsLoading(true);
    try {
      await signUp(values.email, values.password, values.fullName);
      setSuccess(true);
      toast({
        title: 'Գրանցումը հաջողվեց',
        description: 'Խնդրում ենք մուտք գործել ձեր հաշիվ',
      });
      setTimeout(() => navigate('/admin/login'), 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Անհայտ սխալ';
      toast({
        title: 'Գրանցումը ձախողվեց',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-background via-muted/30 to-background p-4">
      <Card className="w-full max-w-md border-primary/20 shadow-xl">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <UserPlus className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-2xl">Գրանցում</CardTitle>
          <CardDescription>Ստեղծեք ձեր հաշիվը</CardDescription>
        </CardHeader>
        <CardContent>
          {success ? (
            <div className="text-center py-8 space-y-4">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                <UserPlus className="h-8 w-8 text-green-600" />
              </div>
              <p className="text-lg font-medium">Գրանցումը հաջողվեց</p>
              <p className="text-sm text-muted-foreground">
                Առաջվա էջ է տեղափոխվում...
              </p>
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(handleRegister)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="fullName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Անուն Ազգանուն</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          autoComplete="name"
                          placeholder="Անուն Ազգանուն"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Էլ. հասցե</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          autoComplete="email"
                          placeholder="example@email.com"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Գաղտնաբառ</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          autoComplete="new-password"
                          placeholder="••••••••"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Գրանցվել
                </Button>
              </form>
            </Form>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 flex items-center gap-4">
        <Link
          to="/admin/login"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Վերադառնալ մուտքի էջ
        </Link>
      </div>
    </div>
  );
};

export default Register;
